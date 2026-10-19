import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getActiveCategories, ALL_CATEGORIES } from "./categories.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { readLogRows, appendLogRow, ensureHeaderRow } from "./sheets.mjs";
import { createGeminiClient, pickTopic, pickTrendingTopic, writeArticle, fixArticleHtml } from "./gemini.mjs";
import { fetchLatestTechNews, filterUncoveredNewsItems } from "./techNews.mjs";
import { parseGeminiArticleResponse } from "./parse.mjs";
import { validateArticle } from "./validate.mjs";
import { imgTag } from "./image.mjs";
import { createR2Client, uploadBufferToR2 } from "./r2upload.mjs";
import { generateImageWithRetry } from "./cfImage.mjs";
import { publishPost } from "./blogger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function alreadyHandledThisWindowToday(pastLog, timeZone, windowId) {
  const today = dateStringInTz(new Date(), timeZone);
  return pastLog.some((row) => {
    if (!row.date || (row.status !== "published" && row.status !== "failed")) return false;
    if (row.window !== windowId) return false;
    const rowDate = new Date(row.date);
    if (Number.isNaN(rowDate.valueOf())) return false;
    return dateStringInTz(rowDate, timeZone) === today;
  });
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isLikelyDuplicate(topic, pastLog) {
  const normTitleId = normalize(topic.titleId);
  const normKeyword = normalize(topic.targetKeyword);
  return pastLog.some((row) => {
    return (
      normalize(row.titleId) === normTitleId ||
      normalize(row.targetKeyword) === normKeyword
    );
  });
}

function insertImageIntoDivs(html, imageHtml) {
  return html.replace(
    /(<div[^>]*id=["'](?:indonesian-version|english-version)["'][^>]*>)/gi,
    (match) => `${match}\n${imageHtml}`
  );
}

async function main() {
  const config = loadConfig();

  const categories = getActiveCategories(config.activeCategories);
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "style-guide.md"), "utf-8");

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
    console.log(`The "${windowId}" window already has a published/failed row today — skipping (prevents double-posting if slots ever overlap).`);
    return;
  }

  console.log(`Loaded ${pastLog.length} past log row(s). Picking a new topic...`);

  const isMorning = windowId === "morning";
  let newsCandidates = [];
  if (isMorning) {
    console.log("Morning window — fetching current tech news from RSS feeds (forced category: Digital Insights)...");
    const newsItems = await fetchLatestTechNews();
    newsCandidates = filterUncoveredNewsItems(newsItems, pastLog);
    console.log(`Fetched ${newsItems.length} news item(s), ${newsCandidates.length} not yet covered.`);
  }

  const pick = (extraAvoid = []) =>
    isMorning
      ? pickTrendingTopic(ai, config.gemini.models, { newsCandidates, pastLog, extraAvoid })
      : pickTopic(ai, config.gemini.models, { categories, pastLog, extraAvoid });

  let topic = await pick();
  if (isLikelyDuplicate(topic, pastLog)) {
    console.log("First topic suggestion looked like a duplicate, asking Gemini again with an explicit nudge...");
    topic = await pick([`- "${topic.titleId}" / "${topic.titleEn}" (keyword: ${topic.targetKeyword})`]);
  }

  // Morning always forces Digital Insights, which may not be in the active
  // rotation list (categories), so resolve against the full category table.
  const category = isMorning ? ALL_CATEGORIES["digital-insights"] : categories.find((c) => c.slug === topic.category);
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
      window: windowId,
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
      window: windowId,
    });

    process.exitCode = 1;
    return;
  }

  console.log("Validation passed. Generating thumbnail image via Cloudflare Workers AI...");
  const r2Client = createR2Client(config.r2);
  const slug = topic.targetKeyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const key = `thumbnails/${dateStringInTz(new Date(), config.publishWindow.timezone)}-${slug}-${Math.floor(Math.random() * 1e6)}.jpg`;

  let finalHtml = parsed.html;
  try {
    const buffer = await generateImageWithRetry({
      accountId: config.r2.accountId,
      apiToken: config.cloudflareApiToken,
      prompt: parsed.meta.thumbnailPrompt,
    });
    const imageUrl = await uploadBufferToR2({
      client: r2Client,
      bucket: config.r2.bucket,
      publicBaseUrl: config.r2.publicBaseUrl,
      buffer,
      key,
    });
    finalHtml = insertImageIntoDivs(parsed.html, imgTag(imageUrl, parsed.meta.altText));
  } catch (err) {
    console.warn(`Thumbnail generation/upload failed after retries (${err.message}). Publishing WITHOUT an image rather than losing a good article.`);
  }

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
    window: windowId,
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
