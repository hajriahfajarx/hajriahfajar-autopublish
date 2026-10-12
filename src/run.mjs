import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.mjs";
import { getActiveCategories } from "./categories.mjs";
import { getOAuthClient } from "./googleAuth.mjs";
import { readLogRows, appendLogRow, ensureHeaderRow } from "./sheets.mjs";
import { createGeminiClient, pickTopic, writeArticle, fixArticleHtml } from "./gemini.mjs";
import { parseGeminiArticleResponse } from "./parse.mjs";
import { validateArticle } from "./validate.mjs";
import { buildThumbnailUrl, imgTag } from "./image.mjs";
import { createR2Client, mirrorImageToR2 } from "./r2upload.mjs";
import { publishPost } from "./blogger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;

function dateStringInTz(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function alreadyHandledToday(pastLog, timeZone) {
  const today = dateStringInTz(new Date(), timeZone);
  return pastLog.some((row) => {
    if (!row.date || (row.status !== "published" && row.status !== "failed")) return false;
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

  if (alreadyHandledToday(pastLog, config.publishWindow.timezone)) {
    console.log("Today already has a published/failed row in the log — skipping (prevents double-posting if slots ever overlap).");
    return;
  }

  console.log(`Loaded ${pastLog.length} past log row(s). Picking a new topic...`);

  let topic = await pickTopic(ai, config.gemini.models, { categories, pastLog });
  if (isLikelyDuplicate(topic, pastLog)) {
    console.log("First topic suggestion looked like a duplicate, asking Gemini again with an explicit nudge...");
    topic = await pickTopic(ai, config.gemini.models, {
      categories,
      pastLog,
      extraAvoid: [`- "${topic.titleId}" / "${topic.titleEn}" (keyword: ${topic.targetKeyword})`],
    });
  }

  const category = categories.find((c) => c.slug === topic.category);
  console.log(`Topic chosen: [${category.label}] "${topic.titleId}" / "${topic.titleEn}"`);

  console.log("Writing full article...");
  let rawResponse = await writeArticle(ai, config.gemini.models, styleGuideTemplate, topic, category.label);
  let parsed = parseGeminiArticleResponse(rawResponse);
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
    });

    process.exitCode = 1;
    return;
  }

  console.log("Validation passed. Generating thumbnail image...");
  const pollinationsUrl = buildThumbnailUrl(parsed.meta.thumbnailPrompt);

  console.log("Mirroring thumbnail to our own R2 bucket (so it doesn't depend on Pollinations staying up long-term)...");
  const r2Client = createR2Client(config.r2);
  const slug = topic.targetKeyword
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const key = `thumbnails/${dateStringInTz(new Date(), config.publishWindow.timezone)}-${slug}-${Math.floor(Math.random() * 1e6)}.jpg`;
  const imageUrl = await mirrorImageToR2({
    client: r2Client,
    bucket: config.r2.bucket,
    publicBaseUrl: config.r2.publicBaseUrl,
    sourceUrl: pollinationsUrl,
    key,
  });

  const imageHtml = imgTag(imageUrl, parsed.meta.altText);
  const finalHtml = insertImageIntoDivs(parsed.html, imageHtml);

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
  });

  console.log("Done.");
}

main().catch((err) => {
  console.error("Pipeline failed with an unexpected error:", err);
  process.exitCode = 1;
});
