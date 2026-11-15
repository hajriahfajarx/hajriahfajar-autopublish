import { validateArticle } from "./validate.mjs";
import { parseGeminiArticleResponse } from "./parse.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// --- Case 1: broken response with leftover placeholders ---
const brokenResponse = `
# BAGIAN A — DATA SEO

Kategori: Digital Insights
Search Intent: How-to
Target Keyword Utama: cara reset wifi
Keyword Turunan (LSI): cara restart router, kenapa wifi mati
Judul Artikel: How to Reset Your Wifi Router
Judul Artikel (Bahasa Indonesia): Cara Reset Wifi Router Kamu
Meta Description: {JUDUL} meta description placeholder not filled in properly for this test case here
Alt Text Gambar Utama: wifi router reset
Prompt Thumbnail: a wifi router glowing blue, digital art
Saran Internal Link: Digital Insights, Productivity

# BAGIAN B — ARTIKEL HTML SIAP BLOGGER

\`\`\`html
<div class="lang-id" style="text-align:justify;">
  <!-- Indonesian content here -->
</div>
<div class="lang-en" style="text-align:justify;">
  <!-- English content here -->
</div>
\`\`\`
`;

const broken = parseGeminiArticleResponse(brokenResponse);
const brokenResult = validateArticle(broken);
assert(brokenResult.ok === false, "broken response should fail validation");
assert(brokenResult.issues.length > 0, "broken response should report issues");
assert(
  brokenResult.issues.some((i) => i.includes("Indonesian content here")),
  "should flag the unfilled Indonesian content placeholder"
);

// --- Case 2: clean response ---
const longId = "Ini adalah paragraf contoh yang cukup panjang untuk lolos validasi kata minimum. ".repeat(80);
const longEn = "This is a sufficiently long sample paragraph to pass the minimum word count check. ".repeat(80);

const cleanResponse = `
# BAGIAN A — DATA SEO

Kategori: Digital Insights
Search Intent: How-to
Target Keyword Utama: cara reset wifi
Keyword Turunan (LSI): cara restart router, kenapa wifi mati
Judul Artikel: How to Reset Your Wifi Router
Judul Artikel (Bahasa Indonesia): Cara Reset Wifi Router Kamu
Meta Description: Learn how to reset your wifi router step by step to fix common connectivity issues at home.
Alt Text Gambar Utama: wifi router reset illustration
Prompt Thumbnail: a wifi router glowing blue, digital art
Saran Internal Link: Digital Insights, Productivity

# BAGIAN B — ARTIKEL HTML SIAP BLOGGER

\`\`\`html
<div class="lang-id" style="text-align:justify;">
  <h2>Cara Reset Wifi</h2>
  <p>${longId}</p>
</div>
<div class="lang-en" style="text-align:justify;">
  <h2>How to Reset Wifi</h2>
  <p>${longEn}</p>
</div>
\`\`\`
`;

const clean = parseGeminiArticleResponse(cleanResponse);
const cleanResult = validateArticle(clean);
if (!cleanResult.ok) {
  console.error("Clean response issues:", cleanResult.issues);
}
assert(cleanResult.ok === true, "clean, fully-filled response should pass validation");

// --- Case 3: label/instruction text leaked into a BAGIAN A field value ---
// Regression test for a real bug: Gemini echoed the field's formatting note
// ("(Bahasa Inggris, mengandung keyword utama secara natural): ...") as part
// of the Alt Text value, which then ended up as the actual <img alt="..."> on
// a live post. Caught by the "starts with (" / "WAJIB menggunakan" check.
const leakedResponse = cleanResponse.replace(
  "Alt Text Gambar Utama: wifi router reset illustration",
  "Alt Text Gambar Utama: (Bahasa Inggris, mengandung keyword utama secara natural): wifi router reset illustration"
);
const leaked = parseGeminiArticleResponse(leakedResponse);
const leakedResult = validateArticle(leaked);
assert(leakedResult.ok === false, "leaked instruction text in a field value should fail validation");
assert(
  leakedResult.issues.some((i) => i.includes("altText") && i.includes("ter-copy")),
  "should specifically flag altText as containing leaked instruction text"
);

// --- Case 4: "Judul Artikel (Bahasa Indonesia)" field missing entirely.
// Regression test for the new bilingual-title-everywhere feature -- the
// theme-wide titles manifest depends on this field matching the lang-id H2
// exactly, so a missing value must fail validation like any other required
// BAGIAN A field.
const noTitleIdResponse = cleanResponse.replace("Judul Artikel (Bahasa Indonesia): Cara Reset Wifi Router Kamu\n", "");
const noTitleId = parseGeminiArticleResponse(noTitleIdResponse);
const noTitleIdResult = validateArticle(noTitleId);
assert(noTitleIdResult.ok === false, "missing Judul Artikel (Bahasa Indonesia) should fail validation");
assert(
  noTitleIdResult.issues.some((i) => i.includes("titleId")),
  "should specifically flag the missing titleId field"
);

// --- Case 5: no lang-id/lang-en classes at all (old id-based/button scheme
// leaking back in, or a malformed response) must still be rejected.
const oldSchemeResponse = cleanResponse.replace(/class="lang-id"/, "id=\"indonesian-version\"").replace(/class="lang-en"/, "id=\"english-version\"");
const oldScheme = parseGeminiArticleResponse(oldSchemeResponse);
const oldSchemeResult = validateArticle(oldScheme);
assert(oldSchemeResult.ok === false, "old id-based divs without lang-id/lang-en classes should fail validation");
assert(
  oldSchemeResult.issues.some((i) => i.includes('class="lang-id"')) && oldSchemeResult.issues.some((i) => i.includes('class="lang-en"')),
  "should specifically flag both missing lang-id and lang-en divs"
);

if (process.exitCode === 1) {
  console.error("\nSome validate.mjs tests FAILED.");
} else {
  console.log("\nAll validate.mjs tests passed.");
}
