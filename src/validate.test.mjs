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
Judul Artikel WAJIB menggunakan Bahasa Inggris: How to Reset Your Wifi Router
Meta Description: {JUDUL} meta description placeholder not filled in properly for this test case here
Alt Text Gambar Utama: wifi router reset
Prompt Thumbnail: a wifi router glowing blue, digital art
Saran Internal Link: Digital Insights, Productivity

# BAGIAN B — ARTIKEL HTML SIAP BLOGGER

\`\`\`html
<div style="text-align:center;"><button>ID</button><button>EN</button></div>
<div id="indonesian-version" style="display:none;">
  <!-- Indonesian content here -->
</div>
<div id="english-version" style="display:none;">
  <!-- English content here -->
</div>
<script>window.__setLang = function(){};</script>
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
Judul Artikel WAJIB menggunakan Bahasa Inggris: How to Reset Your Wifi Router
Meta Description: Learn how to reset your wifi router step by step to fix common connectivity issues at home.
Alt Text Gambar Utama: wifi router reset illustration
Prompt Thumbnail: a wifi router glowing blue, digital art
Saran Internal Link: Digital Insights, Productivity

# BAGIAN B — ARTIKEL HTML SIAP BLOGGER

\`\`\`html
<div style="text-align:center;"><button>ID</button><button>EN</button></div>
<div id="indonesian-version" style="display:none;">
  <h2>Cara Reset Wifi</h2>
  <p>${longId}</p>
</div>
<div id="english-version" style="display:none;">
  <h2>How to Reset Wifi</h2>
  <p>${longEn}</p>
</div>
<script>window.__setLang = function(){};</script>
\`\`\`
`;

const clean = parseGeminiArticleResponse(cleanResponse);
const cleanResult = validateArticle(clean);
if (!cleanResult.ok) {
  console.error("Clean response issues:", cleanResult.issues);
}
assert(cleanResult.ok === true, "clean, fully-filled response should pass validation");

if (process.exitCode === 1) {
  console.error("\nSome validate.mjs tests FAILED.");
} else {
  console.log("\nAll validate.mjs tests passed.");
}
