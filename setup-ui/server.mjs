import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { google } from "googleapis";
import open from "open";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 5577;
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`;
const SCOPES = ["https://www.googleapis.com/auth/blogger", "https://www.googleapis.com/auth/spreadsheets"];

// On Windows, a freshly-installed gh.exe often isn't on PATH yet for an
// already-running shell/process (PATH is only refreshed on new login/reboot
// in some setups). Fall back to the default install location if "gh" alone
// isn't found, instead of silently reporting "not available".
const GH_FALLBACK_PATH = "C:\\Program Files\\GitHub CLI\\gh.exe";
let ghBinaryPromise = null;
async function resolveGhBinary() {
  if (ghBinaryPromise) return ghBinaryPromise;
  ghBinaryPromise = (async () => {
    try {
      await execFileAsync("gh", ["--version"]);
      return "gh";
    } catch {
      if (existsSync(GH_FALLBACK_PATH)) return GH_FALLBACK_PATH;
      return "gh"; // let the real call fail with a clear error
    }
  })();
  return ghBinaryPromise;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

// In-memory state for this local setup session only — never written to disk
// except when the user explicitly clicks Save.
const state = {
  oauthClient: null, // { clientId, clientSecret }
  refreshToken: null,
  blogId: null,
  sheetId: null,
};

async function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

async function serveStatic(req, res, pathname) {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.join(ROOT, "setup-ui", "public", filePath);
  try {
    const content = await readFile(fullPath);
    const ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function checkGhAvailable() {
  try {
    const gh = await resolveGhBinary();
    await execFileAsync(gh, ["auth", "status"]);
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: ROOT });
    return { available: true, remote: stdout.trim() };
  } catch {
    return { available: false, remote: null };
  }
}

function repoSlugFromRemote(remoteUrl) {
  // Handles both git@github.com:owner/repo.git and https://github.com/owner/repo.git
  const match = remoteUrl.match(/github\.com[:/]+([^/]+)\/([^/.]+)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function handleOauthStart(req, res) {
  const body = await readBody(req);
  state.oauthClient = { clientId: body.clientId, clientSecret: body.clientSecret };
  state.blogUrl = body.blogUrl;
  state.blogIdInput = body.blogId || "";
  state.sheetIdInput = body.sheetId || "";

  const client = new google.auth.OAuth2(body.clientId, body.clientSecret, REDIRECT_URI);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  state.codeVerifier = codeVerifier;

  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
  });

  await sendJson(res, 200, { url });
}

async function handleOauthCallback(req, res, query) {
  const code = query.get("code");
  if (!code || !state.oauthClient) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<p>Missing code or OAuth client wasn't started. Close this tab and try again.</p>");
    return;
  }

  try {
    const client = new google.auth.OAuth2(state.oauthClient.clientId, state.oauthClient.clientSecret, REDIRECT_URI);
    const { tokens } = await client.getToken({ code, codeVerifier: state.codeVerifier });
    state.refreshToken = tokens.refresh_token;

    if (!state.refreshToken) {
      throw new Error(
        "Google didn't return a refresh token. This usually means you've authorized this app before — go to https://myaccount.google.com/permissions, remove access for this app, and try Connect again."
      );
    }

    client.setCredentials(tokens);

    const blogger = google.blogger({ version: "v3", auth: client });

    if (state.blogIdInput) {
      // User supplied the Blog ID directly — skip URL auto-detection entirely,
      // but still confirm it resolves so we fail fast with a clear message.
      const { data } = await blogger.blogs.get({ blogId: state.blogIdInput });
      state.blogId = data.id;
    } else {
      // Auto-detect Blog ID. Blogger's getByUrl can be picky about the exact
      // URL form, so try a couple of reasonable variants before giving up.
      const candidateUrls = [
        state.blogUrl,
        state.blogUrl.replace(/\/$/, ""),
        state.blogUrl.replace(/\/$/, "") + "/",
        state.blogUrl.replace(/^https:/, "http:"),
      ];
      let blogData = null;
      let lastErr = null;
      for (const candidate of [...new Set(candidateUrls)]) {
        try {
          const res = await blogger.blogs.getByUrl({ url: candidate });
          blogData = res.data;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!blogData) {
        throw new Error(
          `Blogger API couldn't find a blog at any variant of "${state.blogUrl}" for this Google account. ` +
          `Make sure you logged in with the Google account that owns/authors hajriahfajar.com on Blogger ` +
          `(check at https://www.blogger.com with that account), or fill in the Blog ID field manually ` +
          `(find it in the Blogger dashboard URL: blogger.com/blog/posts/<BLOG_ID>). Original error: ${lastErr?.message || lastErr}`
        );
      }
      state.blogId = blogData.id;
    }

    // Auto-create Sheet if none was given
    const sheets = google.sheets({ version: "v4", auth: client });
    if (state.sheetIdInput) {
      state.sheetId = state.sheetIdInput;
    } else {
      const { data: created } = await sheets.spreadsheets.create({
        requestBody: { properties: { title: "hajriahfajar-autopublish-log" } },
      });
      state.sheetId = created.spreadsheetId;
      await sheets.spreadsheets.values.update({
        spreadsheetId: state.sheetId,
        range: "Sheet1!A1:H1",
        valueInputOption: "RAW",
        requestBody: {
          values: [["date", "status", "category", "title_id", "title_en", "target_keyword", "post_url", "reason"]],
        },
      });
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<p>Connected! You can close this tab and go back to the setup page.</p><script>window.close();</script>");
  } catch (err) {
    console.error("OAuth callback error:", err?.response?.data || err);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<p>Failed to connect: ${String(err.message || err)}</p><p>Close this tab and click "Connect Google Account" again to retry.</p>`);
  }
}

async function handleOauthStatus(req, res) {
  await sendJson(res, 200, {
    connected: Boolean(state.refreshToken),
    blogId: state.blogId,
    sheetId: state.sheetId,
  });
}

async function handleGhStatus(req, res) {
  const gh = await checkGhAvailable();
  await sendJson(res, 200, gh);
}

function buildEnvFile(values) {
  return `GEMINI_API_KEY=${values.geminiApiKey}
GEMINI_MODEL=gemini-flash-latest,gemini-flash-lite-latest
GOOGLE_CLIENT_ID=${state.oauthClient?.clientId || ""}
GOOGLE_CLIENT_SECRET=${state.oauthClient?.clientSecret || ""}
GOOGLE_REFRESH_TOKEN=${state.refreshToken || ""}
BLOG_ID=${state.blogId || ""}
SHEET_ID=${state.sheetId || ""}
PUBLISH_WINDOW_START=${values.windowStart}
PUBLISH_WINDOW_END=${values.windowEnd}
PUBLISH_TIMEZONE=Asia/Jakarta
ACTIVE_CATEGORIES=${values.categories.join(",")}
SKIP_RANDOM_SLEEP=false
`;
}

async function handleSave(req, res) {
  const body = await readBody(req);

  if (!state.refreshToken || !state.blogId || !state.sheetId) {
    await sendJson(res, 400, { error: "Connect your Google account first (Blog ID / Sheet ID missing)." });
    return;
  }

  const envContent = buildEnvFile(body);
  await writeFile(path.join(ROOT, ".env"), envContent, "utf-8");

  const results = { envWritten: true, secretsPushed: null };

  if (body.pushToGithub) {
    const gh = await checkGhAvailable();
    if (!gh.available) {
      results.secretsPushed = { ok: false, error: "GitHub CLI (gh) not authenticated, or this folder has no git remote 'origin' yet." };
    } else {
      const repo = repoSlugFromRemote(gh.remote);
      if (!repo) {
        results.secretsPushed = { ok: false, error: `Could not parse a GitHub owner/repo from remote: ${gh.remote}` };
      } else {
        const secretValues = {
          GEMINI_API_KEY: body.geminiApiKey,
          GEMINI_MODEL: "gemini-flash-latest,gemini-flash-lite-latest",
          GOOGLE_CLIENT_ID: state.oauthClient?.clientId || "",
          GOOGLE_CLIENT_SECRET: state.oauthClient?.clientSecret || "",
          GOOGLE_REFRESH_TOKEN: state.refreshToken || "",
          BLOG_ID: state.blogId || "",
          SHEET_ID: state.sheetId || "",
          PUBLISH_WINDOW_START: body.windowStart,
          PUBLISH_WINDOW_END: body.windowEnd,
          PUBLISH_TIMEZONE: "Asia/Jakarta",
          ACTIVE_CATEGORIES: body.categories.join(","),
        };

        const gh = await resolveGhBinary();
        const perSecret = {};
        for (const [name, value] of Object.entries(secretValues)) {
          try {
            await execFileAsync(gh, ["secret", "set", name, "--repo", repo, "--body", value]);
            perSecret[name] = "ok";
          } catch (err) {
            perSecret[name] = `error: ${String(err.message || err)}`;
          }
        }
        results.secretsPushed = { ok: true, repo, perSecret };
      }
    }
  }

  await sendJson(res, 200, results);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/oauth/start") return handleOauthStart(req, res);
    if (req.method === "GET" && url.pathname === "/oauth/callback") return handleOauthCallback(req, res, url.searchParams);
    if (req.method === "GET" && url.pathname === "/api/oauth/status") return handleOauthStatus(req, res);
    if (req.method === "GET" && url.pathname === "/api/gh/status") return handleGhStatus(req, res);
    if (req.method === "POST" && url.pathname === "/api/save") return handleSave(req, res);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    await sendJson(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Setup UI running at ${url}`);
  try {
    await open(url);
  } catch {
    console.log("Couldn't auto-open a browser — open the URL above manually.");
  }
});
