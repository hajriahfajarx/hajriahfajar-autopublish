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
import { isLikelyDuplicate } from "./dedup.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FIX_ATTEMPTS = 3;
const MAX_WRITE_ATTEMPTS = 2;

// Batch-writes several evening-window articles in one run (once a week,
// off-peak) and queues them as `ready` rows in the Sheet, instead of calling
// Gemini at every single publish moment (2x/day). The daily publish job
// (run.mjs) then just pulls the oldest `ready` row and posts it -- no Gemini
// call at publish time at all for this window. The morning window (current
// RSS tech news) is NOT batched here -- see run.mjs, it stays real-time
// since pre-writing "today's trending news" days in advance would make it
// stale by the time it's actually posted.
async function main() {
  const config = loadConfig();
  const categories = getActiveCategories(config.activeCategories);
  const styleGuideTemplate = readFileSync(path.join(__dirname, "..", "prompts", "style-guide.md"), "utf-8");

  const auth = getOAuthClient(config.google);
  const ai = createGeminiClient({ apiKey: config.gemini.apiKey });

  await ensureHeaderRow(auth, config.sheetId);
  const pastLog = await readLogRows(auth, config.sheetId);
  // Grows as the batch picks topics, so later iterations in this same run
  // also avoid duplicating earlier ones -- not just past Sheet history.
  const combinedLog = [...pastLog];

  const count = parseInt(process.env.GENERATE_COUNT || "10", 10);
  console.log(`Generating ${count} evening-window article(s) into the queue...`);

  let readyCount = 0;
  let failedCount = 0;

  for (let i = 1; i <= count; i++) {
    console.log(`\n--- Article ${i}/${count} ---`);

    const pick = (extraAvoid = []) => pickTopic(ai, config.gemini.models, { categories, pastLog: combinedLog, extraAvoid });

    let topic = await pick();
    if (isLikelyDuplicate(topic, combinedLog)) {
      console.log("Topic suggestion looked like a duplicate, asking Gemini again with an explicit nudge...");
      topic = await pick([`- "${topic.titleId}" / "${topic.titleEn}" (keyword: ${topic.targetKeyword})`]);
    }

    const category = categories.find((c) => c.slug === topic.category);
    console.log(`Topic chosen: [${category.label}] "${topic.titleId}" / "${topic.titleEn}"`);

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
      }
    }

    combinedLog.push({ titleId: topic.titleId, titleEn: topic.titleEn, targetKeyword: topic.targetKeyword });

    if (!parsed) {
      console.error(`Could not get a parseable article after ${MAX_WRITE_ATTEMPTS} attempt(s). Logging as failed, moving on to the next one.`);
      await appendLogRow(auth, config.sheetId, {
        date: new Date().toISOString(),
        status: "failed",
        category: category.label,
        titleId: topic.titleId,
        titleEn: topic.titleEn,
        targetKeyword: topic.targetKeyword,
        reason: `Unparseable response: ${writeFailureReason}`,
        window: "evening",
      });
      failedCount++;
      continue;
    }

    let result = validateArticle(parsed);
    let attempt = 1;
    while (!result.ok && attempt < MAX_FIX_ATTEMPTS) {
      attempt += 1;
      console.log(`Validation found ${result.issues.length} issue(s), attempt ${attempt}/${MAX_FIX_ATTEMPTS} to fix:`);
      result.issues.forEach((issue) => console.log(`  - ${issue}`));

      const fixedHtmlResponse = await fixArticleHtml(ai, config.gemini.models, parsed.html, result.issues);
      const fixedHtmlMatch = fixedHtmlResponse.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
      if (fixedHtmlMatch) {
        parsed = { ...parsed, html: fixedHtmlMatch[1].trim() };
      }
      result = validateArticle(parsed);
    }

    if (!result.ok) {
      console.error(`Article failed validation after ${attempt} attempt(s). Logging as failed, moving on to the next one.`);
      result.issues.forEach((issue) => console.error(`  - ${issue}`));
      await appendLogRow(auth, config.sheetId, {
        date: new Date().toISOString(),
        status: "failed",
        category: category.label,
        titleId: topic.titleId,
        titleEn: topic.titleEn,
        targetKeyword: topic.targetKeyword,
        reason: result.issues.join(" | "),
        window: "evening",
      });
      failedCount++;
      continue;
    }

    await appendLogRow(auth, config.sheetId, {
      date: new Date().toISOString(),
      status: "ready",
      category: category.label,
      titleId: topic.titleId,
      titleEn: topic.titleEn,
      targetKeyword: topic.targetKeyword,
      window: "evening",
      contentHtml: parsed.html,
      altText: parsed.meta.altText,
      thumbnailPrompt: parsed.meta.thumbnailPrompt,
    });
    readyCount++;
    console.log(`Queued as ready: "${topic.titleId}" / "${topic.titleEn}"`);
  }

  console.log(`\nDone. ${readyCount} article(s) queued as ready, ${failedCount} failed.`);
}

main().catch((err) => {
  console.error("Generate batch failed with an unexpected error:", err);
  process.exitCode = 1;
});
