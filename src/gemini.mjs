import { GoogleGenAI } from "@google/genai";

export function createGeminiClient({ apiKey }) {
  return new GoogleGenAI({ apiKey });
}

/**
 * Asks Gemini (JSON mode) to propose one new, non-duplicate article topic
 * from the allowed categories, given the log of titles/keywords already used.
 */
export async function pickTopic(ai, model, { categories, pastLog, extraAvoid = [] }) {
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

  const response = await ai.models.generateContent({
    model,
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
 * Fills the style-guide template's INPUT PENGGUNA placeholders and asks
 * Gemini to write the full BAGIAN A + BAGIAN B article.
 */
export async function writeArticle(ai, model, styleGuideTemplate, topic, categoryLabel) {
  const filled = styleGuideTemplate
    .replaceAll("{{CATEGORY_LABEL}}", categoryLabel)
    .replaceAll("{{SEARCH_INTENT}}", topic.searchIntent)
    .replaceAll("{{TARGET_KEYWORD}}", topic.targetKeyword)
    .replaceAll("{{LSI_KEYWORDS}}", topic.lsiKeywords.join(", "))
    .replaceAll("{{TITLE_ID}}", topic.titleId)
    .replaceAll("{{TITLE_EN}}", topic.titleEn)
    .replaceAll("{{BRIEF}}", topic.brief);

  const response = await ai.models.generateContent({
    model,
    contents: filled,
  });

  return response.text;
}

/**
 * Sends back a list of concrete problems found in the generated HTML and
 * asks Gemini to return a corrected fenced HTML block only.
 */
export async function fixArticleHtml(ai, model, brokenHtml, issues) {
  const prompt = `Berikut adalah HTML artikel blog yang perlu diperbaiki. Ditemukan masalah berikut:

${issues.map((i) => `- ${i}`).join("\n")}

HTML yang perlu diperbaiki (perbaiki HANYA bagian yang bermasalah, jangan ubah konten lain yang sudah benar):

\`\`\`html
${brokenHtml}
\`\`\`

Balas HANYA dengan HTML yang sudah diperbaiki, dalam SATU fenced code block \`\`\`html ... \`\`\`, tanpa penjelasan tambahan, tanpa BAGIAN A, tanpa teks lain di luar code block.`;

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
  });

  return response.text;
}
