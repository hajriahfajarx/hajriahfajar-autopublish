import { GoogleGenAI } from "@google/genai";

export function createGeminiClient({ apiKey }) {
  return new GoogleGenAI({ apiKey });
}

function isRetryableStatus(err) {
  const status = err?.status || err?.response?.status;
  return status === 503 || status === 429 || status === 500;
}

async function generateContentWithRetry(ai, params, { retries = 4, baseDelayMs = 5000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryableStatus(err)) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.log(`Gemini call failed (${err?.status || "unknown status"}), retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${retries})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Tries each model in `models` (in order) with its own retry-with-backoff
 * cycle, falling through to the next model only once a given model has
 * exhausted its retries. This is what protects a daily run from a single
 * model (e.g. "gemini-flash-latest") being temporarily overloaded — seen in
 * practice during initial testing (503 UNAVAILABLE), where falling back to
 * "gemini-flash-lite-latest" succeeded immediately.
 */
async function generateContentWithFallback(ai, models, paramsWithoutModel, retryOpts) {
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      return await generateContentWithRetry(ai, { ...paramsWithoutModel, model: models[i] }, retryOpts);
    } catch (err) {
      lastErr = err;
      if (i < models.length - 1) {
        console.log(`Model "${models[i]}" exhausted its retries, falling back to "${models[i + 1]}"...`);
      }
    }
  }
  throw lastErr;
}

/**
 * Asks Gemini (JSON mode) to propose one new, non-duplicate article topic
 * from the allowed categories, given the log of titles/keywords already used.
 */
export async function pickTopic(ai, models, { categories, pastLog, extraAvoid = [] }) {
  const categoryList = categories.map((c) => `- ${c.label} (slug: ${c.slug}): ${c.description}`).join("\n");
  const pastList = pastLog.length
    ? pastLog.map((r) => `- [${r.category}] "${r.titleId}" / "${r.titleEn}" (keyword: ${r.targetKeyword})`).join("\n")
    : "(belum ada artikel sebelumnya)";
  const avoidExtra = extraAvoid.length ? `\n\nTopik ini JUGA sudah dicoba dan harus dihindari lagi:\n${extraAvoid.join("\n")}` : "";

  const prompt = `Kamu membantu memilih SATU topik artikel blog baru untuk hajriahfajar.com (blog teknologi, produktivitas, mindset, dan faith & society berbahasa Indonesia/Inggris).

Kategori yang BOLEH dipilih (pilih hanya satu):
${categoryList}

Daftar artikel yang SUDAH PERNAH dibuat (jangan buat topik yang sama atau terlalu mirip):
${pastList}${avoidExtra}

Pilih SATU topik baru yang:
- belum pernah dibahas di daftar atas (hindari judul/keyword yang sama atau sangat mirip)
- relevan untuk pembaca umum yang mencari informasi praktis di Google
- punya potensi pencarian yang wajar (bukan terlalu niche/sempit, bukan terlalu generik)

Balas HANYA dalam format JSON valid (tanpa markdown, tanpa penjelasan tambahan) dengan skema persis seperti ini:
{
  "category": "<salah satu slug kategori di atas>",
  "titleId": "<judul draft Bahasa Indonesia>",
  "titleEn": "<judul draft Bahasa Inggris>",
  "searchIntent": "<Informational | How-to/Troubleshooting | Comparison | Opinion>",
  "targetKeyword": "<target keyword utama, bahasa pencarian natural>",
  "lsiKeywords": ["<keyword turunan 1>", "<keyword turunan 2>", "<keyword turunan 3>"],
  "brief": "<2-3 kalimat sudut pandang/angle artikel ini>"
}`;

  const response = await generateContentWithFallback(ai, models, {
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  const text = response.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini pickTopic returned invalid JSON: ${text?.slice(0, 500)}`);
  }

  const validSlugs = new Set(categories.map((c) => c.slug));
  if (!validSlugs.has(parsed.category)) {
    throw new Error(`Gemini picked an invalid category slug: "${parsed.category}"`);
  }

  return parsed;
}

/**
 * Morning-window variant of pickTopic: forces category to Digital Insights
 * and picks from real, current tech news headlines (fetched for free from
 * public RSS feeds — see techNews.mjs) instead of the model's static
 * training data. Gemini's job here is judgment, not research: pick the ONE
 * candidate that's a genuinely interesting, appropriate mainstream tech
 * story (not crime/legal drama/disturbing content, which raw news feeds
 * absolutely do include — hit this for real when the top item from a feed
 * was a criminal case), then structure it into our topic JSON schema.
 *
 * (Originally tried Gemini's own `googleSearch` grounding tool instead of
 * RSS, but that requires billing enabled on Gemini 3.x — no free tier for
 * grounding. RSS is free and avoids that entirely.)
 */
export async function pickTrendingTopic(ai, models, { newsCandidates, pastLog, extraAvoid = [] }) {
  if (!newsCandidates.length) {
    throw new Error("No uncovered news candidates available to pick a trending topic from.");
  }

  const candidateList = newsCandidates
    .map((item, i) => `${i + 1}. [${item.source}] "${item.title}" — ${item.description} (${item.pubDate})`)
    .join("\n");
  const pastList = pastLog.length
    ? pastLog.map((r) => `- [${r.category}] "${r.titleId}" / "${r.titleEn}" (keyword: ${r.targetKeyword})`).join("\n")
    : "(belum ada artikel sebelumnya)";
  const avoidExtra = extraAvoid.length ? `\n\nTopik ini JUGA sudah dicoba dan harus dihindari lagi:\n${extraAvoid.join("\n")}` : "";

  const prompt = `Berikut daftar berita teknologi terbaru (real, dari RSS feed situs berita teknologi hari ini):

${candidateList}

Tugasmu: pilih SATU berita dari daftar di atas yang paling cocok dijadikan artikel blog teknologi untuk pembaca umum (hajriahfajar.com, kategori Digital Insights).

Kriteria pemilihan — WAJIB dihindari:
- Berita kriminal, kekerasan, konten tidak pantas/sensitif, atau isu hukum/pengadilan
- Berita politik murni atau drama internal perusahaan yang tidak relevan ke pembaca umum
- Berita yang sudah mirip dengan daftar yang pernah dibahas ini:
${pastList}${avoidExtra}

Pilih yang: produk/teknologi baru, update AI/software, tren yang sedang ramai dibicarakan, isu keamanan digital, atau hal yang relevan & menarik untuk pembaca umum.

Setelah memilih, buat draft topik artikel blog dari berita tersebut (berbahasa Indonesia/Inggris), dengan sudut pandang yang relevan untuk pembaca umum (jelaskan kenapa ini penting/menarik untuk mereka, bukan cuma melaporkan berita apa adanya).

Balas HANYA dalam format JSON valid (tanpa markdown, tanpa penjelasan tambahan) dengan skema persis seperti ini:
{
  "category": "digital-insights",
  "titleId": "<judul draft Bahasa Indonesia>",
  "titleEn": "<judul draft Bahasa Inggris>",
  "searchIntent": "<Informational | How-to/Troubleshooting | Comparison | Opinion>",
  "targetKeyword": "<target keyword utama, bahasa pencarian natural>",
  "lsiKeywords": ["<keyword turunan 1>", "<keyword turunan 2>", "<keyword turunan 3>"],
  "brief": "<2-3 kalimat sudut pandang/angle artikel ini, sebutkan juga sumber berita aslinya>",
  "sourceUrl": "<link berita asli yang dipilih, dari daftar di atas>"
}`;

  const response = await generateContentWithFallback(ai, models, {
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  const text = response.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini pickTrendingTopic returned invalid JSON: ${text?.slice(0, 500)}`);
  }

  parsed.category = "digital-insights"; // force, regardless of what the model echoed back
  return parsed;
}

/**
 * Fills the style-guide template's INPUT PENGGUNA placeholders and asks
 * Gemini to write the full BAGIAN A + BAGIAN B article.
 */
export async function writeArticle(ai, models, styleGuideTemplate, topic, categoryLabel) {
  const filled = styleGuideTemplate
    .replaceAll("{{CATEGORY_LABEL}}", categoryLabel)
    .replaceAll("{{SEARCH_INTENT}}", topic.searchIntent)
    .replaceAll("{{TARGET_KEYWORD}}", topic.targetKeyword)
    .replaceAll("{{LSI_KEYWORDS}}", topic.lsiKeywords.join(", "))
    .replaceAll("{{TITLE_ID}}", topic.titleId)
    .replaceAll("{{TITLE_EN}}", topic.titleEn)
    .replaceAll("{{BRIEF}}", topic.brief);

  const response = await generateContentWithFallback(ai, models, {
    contents: filled,
  });

  return response.text;
}

/**
 * Sends back a list of concrete problems found in the generated HTML and
 * asks Gemini to return a corrected fenced HTML block only.
 */
export async function fixArticleHtml(ai, models, brokenHtml, issues) {
  const prompt = `Berikut adalah HTML artikel blog yang perlu diperbaiki. Ditemukan masalah berikut:

${issues.map((i) => `- ${i}`).join("\n")}

HTML yang perlu diperbaiki (perbaiki HANYA bagian yang bermasalah, jangan ubah konten lain yang sudah benar):

\`\`\`html
${brokenHtml}
\`\`\`

Balas HANYA dengan HTML yang sudah diperbaiki, dalam SATU fenced code block \`\`\`html ... \`\`\`, tanpa penjelasan tambahan, tanpa BAGIAN A, tanpa teks lain di luar code block.`;

  const response = await generateContentWithFallback(ai, models, {
    contents: prompt,
  });

  return response.text;
}
