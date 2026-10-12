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
import { publishPost } from "./blogger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;

function parseTimeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function randomDelayMs(windowStart, windowEnd) {
  const startMin = parseTimeToMinutes(windowStart);
  const endMin = parseTimeToMinutes(windowEnd);
  const spanMin = Math.max(0, endMin - startMin);
  const randomMin = Math.random() * spanMin;
  return Math.round(randomMin * 60 * 1000);
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

async function sleepRandomWithinWindow(config) {
  if (config.skipRandomSleep) {
    console.log("SKIP_RANDOM_SLEEP=true — skipping the randomized publish-time delay.");
    return;
  }
  const delay = randomDelayMs(config.publishWindow.start, config.publishWindow.end);
  console.log(`Sleeping ${Math.round(delay / 60000)} minute(s) to land within the ${config.publishWindow.start}-${config.publishWindow.end} ${config.publishWindow.timezone} publish window...`);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function main() {
  const config = loadConfig();
  await sleepRandomWithinWindow(config);

  const categories = getActiveCategories(config.activeCategories);
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "style-guide.md"), "utf-8");

  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRow(auth, config.sheetId);
  const pastLog = await readLogRows(auth, config.sheetId);

  console.log(`Loaded ${pastLog.length} past log row(s). Picking a new topic...`);

  let topic = await pickTopic(ai, config.gemini.model, { categories, pastLog });
  if (isLikelyDuplicate(topic, pastLog)) {
    console.log("First topic suggestion looked like a duplicate, asking Gemini again with an explicit nudge...");
    topic = await pickTopic(ai, config.gemini.model, {
      categories,
      pastLog,
      extraAvoid: [`- "${topic.titleId}" / "${topic.titleEn}" (keyword: ${topic.targetKeyword})`],
    });
  }

  const category = categories.find((c) => c.slug === topic.category);
  console.log(`Topic chosen: [${category.label}] "${topic.titleId}" / "${topic.titleEn}"`);

  console.log("Writing full article...");
  let rawResponse = await writeArticle(ai, config.gemini.model, styleGuideTemplate, topic, category.label);
  let parsed = parseGeminiArticleResponse(rawResponse);
  let result = validateArticle(parsed);

  let attempt = 1;
  while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
    attempt += 1;
    console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
    result.issues.forEach((i) => console.log(`  - ${i}`));

    const fixedHtmlResponse = await fixArticleHtml(ai, config.gemini.model, parsed.html, result.issues);
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
  const imageUrl = buildThumbnailUrl(parsed.meta.thumbnailPrompt);
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
