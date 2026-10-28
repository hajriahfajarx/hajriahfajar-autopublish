import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { ALL_CATEGORIES } from "./categories.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { readLogRows, appendLogRow, updateRow, ensureHeaderRow } from "./sheets.mjs";
import { createGeminiClient, pickTrendingTopic, writeArticle, fixArticleHtml } from "./gemini.mjs";
import { fetchLatestTechNews, filterUncoveredNewsItems } from "./techNews.mjs";
import { parseGeminiArticleResponse } from "./parse.mjs";
import { validateArticle } from "./validate.mjs";
import { isLikelyDuplicate } from "./dedup.mjs";
import { imgTag } from "./image.mjs";
import { createR2Client, uploadBufferToR2 } from "./r2upload.mjs";
import { generateImageWithRetry } from "./cfImage.mjs";
import { publishPost } from "./blogger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// Only a terminal "posted" status blocks the rest of today's slots for this
// window -- a "failed" row (e.g. a transient Gemini 503 storm) must NOT
// block retries, otherwise a single bad slot wastes the whole window's
// redundancy and the window ends up with no article at all that day.
// "published" = morning's real-time path; "done" = evening's queue-consume
// path (see below) -- both mean "this window is handled for today".
function alreadyHandledThisWindowToday(pastLog, timeZone, windowId) {
  const today = dateStringInTz(new Date(), timeZone);
  return pastLog.some((row) => {
    if (!row.date || (row.status !== "published" && row.status !== "done")) return false;
    if (row.window !== windowId) return false;
    const rowDate = new Date(row.date);
    if (Number.isNaN(rowDate.valueOf())) return false;
    return dateStringInTz(rowDate, timeZone) === today;
  });
}

function insertImageIntoDivs(html, imageHtml) {
  return html.replace(
    /(<div[^>]*id=["'](?:indonesian-version|english-version)["'][^>]*>)/gi,
    (match) => `${match}\n${imageHtml}`
  );
}

// Morning: unchanged real-time path -- picks from genuinely current RSS tech
// news and writes it live, right now. NOT batched (see generate.mjs for why).
async function runMorning(config, auth, ai, pastLog) {
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "style-guide.md"), "utf-8");

  console.log("Morning window — fetching current tech news from RSS feeds (forced category: Digital Insights)...");
  const newsItems = await fetchLatestTechNews();
  const newsCandidates = filterUncoveredNewsItems(newsItems, pastLog);
  console.log(`Fetched ${newsItems.length} news item(s), ${newsCandidates.length} not yet covered.`);

  const pick = (extraAvoid = []) => pickTrendingTopic(ai, config.gemini.models, { newsCandidates, pastLog, extraAvoid });

  let topic = await pick();
  if (isLikelyDuplicate(topic, pastLog)) {
    console.log("First topic suggestion looked like a duplicate, asking Gemini again with an explicit nudge...");
    topic = await pick([`- "${topic.titleId}" / "${topic.titleEn}" (keyword: ${topic.targetKeyword})`]);
  }

  const category = ALL_CATEGORIES["digital-insights"];
  console.log(`Topic chosen: [${category.label}] "${topic.titleId}" / "${topic.titleEn}"`);

  console.log("Writing full article...");
  const MAX_WRITE_ATTEMPTS = 2;
  let parsed = null;
  let writeFailureReason = null;
  for (let writeAttempt = 1; writeAttempt <= MAX_WRITE_ATTEMPTS; writeAttempt++) {
    let rawResponse;
    try {
      rawResponse = await writeArticle(ai, config.gemini.models, styleGuideTemplate, topic, category.label);
      parsed = parseGeminiArticleResponse(rawResponse);
      writeFailureReason = null;
      break;
    } catch (err) {
      writeFailureReason = err.message;
      console.log(`Gemini's response (attempt ${writeAttempt}/${MAX_WRITE_ATTEMPTS}) didn't parse: ${err.message}`);
      if (rawResponse) {
        console.log(`--- Raw response length: ${rawResponse.length} chars ---`);
        console.log(`--- Last 500 chars (to check for truncation) ---\n${rawResponse.slice(-500)}`);
        console.log(`--- First 500 chars ---\n${rawResponse.slice(0, 500)}`);
      } else {
        console.log("--- No raw response at all (the Gemini call itself threw) ---");
      }
    }
  }

  if (!parsed) {
    console.error(`Could not get a parseable article from Gemini after ${MAX_WRITE_ATTEMPTS} attempt(s). NOT publishing.`);
    await appendLogRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "failed",
      category: category.label,
      titleId: topic.titleId,
      titleEn: topic.titleEn,
      targetKeyword: topic.targetKeyword,
      reason: `Unparseable response: ${writeFailureReason}`,
      window: "morning",
    });
    process.exitCode = 1;
    return;
  }

  let result = validateArticle(parsed);

  let attempt = 1;
  while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
    attempt += 1;
    console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
    result.issues.forEach((i) => console.log(`  - ${i}`));

    const fixedHtmlResponse = await fixArticleHtml(ai, config.gemini.models, parsed.html, result.issues);
    const fixedHtmlMatch = fixedHtmlResponse.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
    if (fixedHtmlMatch) {
      parsed = { ...parsed, html: fixedHtmlMatch[1].trim() };
    }
    result = validateArticle(parsed);
  }

  if (!result.ok) {
    console.error(`Article failed validation after ${attempt} attempt(s). NOT publishing. Issues:`);
    result.issues.forEach((i) => console.error(`  - ${i}`));

    await appendLogRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "failed",
      category: category.label,
      titleId: topic.titleId,
      titleEn: topic.titleEn,
      targetKeyword: topic.targetKeyword,
      reason: result.issues.join(" | "),
      window: "morning",
    });

    process.exitCode = 1;
    return;
  }

  console.log("Validation passed. Generating thumbnail image via Cloudflare Workers AI...");
  const finalHtml = await addThumbnail(config, parsed.html, parsed.meta.thumbnailPrompt, parsed.meta.altText, topic.targetKeyword);

  console.log(config.draftMode ? "Saving as DRAFT on Blogger (DRAFT_MODE=true)..." : "Publishing to Blogger...");
  const published = await publishPost(auth, {
    blogId: config.blogId,
    title: parsed.meta.titleEn,
    contentHtml: finalHtml,
    label: category.label,
    isDraft: config.draftMode,
  });

  console.log(`${config.draftMode ? "Saved as draft" : "Published"}: ${published.url}`);

  await appendLogRow(auth, config.sheetId, {
    date: new Date().toISOString(),
    status: "published",
    category: category.label,
    titleId: topic.titleId,
    titleEn: topic.titleEn,
    targetKeyword: topic.targetKeyword,
    postUrl: published.url,
    window: "morning",
  });
}

async function addThumbnail(config, html, thumbnailPrompt, altText, slugSource) {
  const r2Client = createR2Client(config.r2);
  const slug = slugSource
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const key = `thumbnails/${dateStringInTz(new Date(), config.publishWindow.timezone)}-${slug}-${Math.floor(Math.random() * 1e6)}.jpg`;

  try {
    const buffer = await generateImageWithRetry({
      accountId: config.r2.accountId,
      apiToken: config.cloudflareApiToken,
      prompt: thumbnailPrompt,
    });
    const imageUrl = await uploadBufferToR2({
      client: r2Client,
      bucket: config.r2.bucket,
      publicBaseUrl: config.r2.publicBaseUrl,
      buffer,
      key,
    });
    return insertImageIntoDivs(html, imgTag(imageUrl, altText));
  } catch (err) {
    console.warn(`Thumbnail generation/upload failed after retries (${err.message}). Publishing WITHOUT an image rather than losing a good article.`);
    return html;
  }
}

// Evening: no Gemini call at all -- pulls the oldest `ready` row (written by
// generate.mjs's weekly batch) out of the queue, generates a fresh
// thumbnail for it, marks it `done`, and publishes.
async function runEvening(config, auth, pastLog) {
  const readyRows = pastLog.filter((row) => row.status === "ready" && row.window === "evening");
  if (readyRows.length === 0) {
    console.log('No "ready" rows in the queue for the evening window — nothing to publish. Run the generate workflow (or "Run workflow" on generate.yml) to top up the queue.');
    return;
  }

  // Oldest first (Sheet rows are already in append order, i.e. rowIndex order).
  const row = readyRows.sort((a, b) => a.rowIndex - b.rowIndex)[0];
  console.log(`Picked queued article (row ${row.rowIndex}): [${row.category}] "${row.titleId}" / "${row.titleEn}"`);

  console.log("Generating thumbnail image via Cloudflare Workers AI...");
  const finalHtml = await addThumbnail(config, row.contentHtml, row.thumbnailPrompt, row.altText, row.targetKeyword);

  console.log(config.draftMode ? "Saving as DRAFT on Blogger (DRAFT_MODE=true)..." : "Publishing to Blogger...");
  const published = await publishPost(auth, {
    blogId: config.blogId,
    title: row.titleEn,
    contentHtml: finalHtml,
    label: row.category,
    isDraft: config.draftMode,
  });

  console.log(`${config.draftMode ? "Saved as draft" : "Published"}: ${published.url}`);

  await updateRow(auth, config.sheetId, row.rowIndex, {
    ...row,
    date: new Date().toISOString(),
    status: "done",
    postUrl: published.url,
  });
}

async function main() {
  const config = loadConfig();
  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRow(auth, config.sheetId);
  const pastLog = await readLogRows(auth, config.sheetId);

  const windowId = config.publishWindow.id;
  if (process.env.FORCE_RUN === "true") {
    console.log("FORCE_RUN=true — skipping the already-handled-this-window-today guard (manual test only, never set this in the scheduled workflow).");
  } else if (windowId === "manual") {
    console.log('PUBLISH_WINDOW_ID is "manual" (workflow_dispatch or local run) — dedup guard skipped, this is an intentional extra run.');
  } else if (alreadyHandledThisWindowToday(pastLog, config.publishWindow.timezone, windowId)) {
    console.log(`The "${windowId}" window already has a published/done row today — skipping (prevents double-posting if slots ever overlap).`);
    return;
  }

  console.log(`Loaded ${pastLog.length} past log row(s).`);

  const isMorning = windowId === "morning";
  if (isMorning) {
    await runMorning(config, auth, ai, pastLog);
  } else {
    await runEvening(config, auth, pastLog);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
