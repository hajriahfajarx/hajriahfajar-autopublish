const PLACEHOLDER_PATTERNS = [
  /\{\{.*?\}\}/,
  /\{JUDUL\}/i,
  /\{URL\}/i,
  /\[nama\s/i,
  /\[disamarkan\]/i,
  /lorem ipsum/i,
  /\bTODO\b/,
  /example\.com/i,
  /ca-pub-XXXX/i,
  /<!--\s*Indonesian content here\s*-->/i,
  /<!--\s*English content here\s*-->/i,
];

const MIN_WORDS_PER_LANGUAGE = 500;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function extractDiv(html, id) {
  const re = new RegExp(`<div[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</div>\\s*(?=<div|<script|$)`, "i");
  const match = html.match(re);
  return match ? match[1] : "";
}

export function validateArticle({ meta, html }) {
  const issues = [];

  for (const [field, value] of Object.entries(meta)) {
    if (!value || !value.trim()) {
      issues.push(`Field BAGIAN A "${field}" kosong — wajib diisi.`);
      continue;
    }
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(value))) {
      issues.push(`Field BAGIAN A "${field}" masih mengandung placeholder yang belum diisi: "${value}".`);
    }
    // A value starting with a parenthetical, or containing instruction-like
    // phrasing, usually means the field's formatting note leaked into the
    // answer instead of being stripped (seen in practice with Prompt
    // Thumbnail / Alt Text Gambar Utama).
    if (/^\s*\(/.test(value) || /WAJIB menggunakan/i.test(value)) {
      issues.push(`Field BAGIAN A "${field}" sepertinya berisi instruksi/catatan format yang ikut ter-copy, bukan isi sebenarnya: "${value}".`);
    }
  }

  if (!html || !html.trim()) {
    issues.push("BAGIAN B (HTML artikel) kosong atau tidak ditemukan di dalam fenced code block.");
    return { ok: false, issues };
  }

  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(html)) {
      issues.push(`HTML artikel masih mengandung placeholder yang belum diisi (pola: ${pattern}).`);
    }
  }

  // NOTE: checking only for the substring "window.__setLang" is NOT enough
  // -- the toggle buttons' own onclick attributes ("window.__setLang &&
  // window.__setLang('id', true)") always contain that exact text, so that
  // check always "passes" even when the entire <script> block that DEFINES
  // the function is missing. Seen in practice: real published posts with
  // both language divs present (and still display:none, since nothing ever
  // sets them visible) but zero <script> tags anywhere -- this check let
  // every one of them through. Require an actual script block containing
  // the function's DEFINITION, not just a reference/call to it.
  const hasScriptBlock = /<script[\s\S]*?<\/script>/i.test(html);
  const hasSetLangDefinition = /window\.__setLang\s*=\s*function/.test(html);
  if (!hasScriptBlock || !hasSetLangDefinition) {
    issues.push("Script toggle bahasa (definisi window.__setLang di dalam <script>) tidak ditemukan atau tidak lengkap di HTML -- kedua versi bahasa akan tetap tersembunyi (display:none) selamanya tanpa ini.");
  }

  const buttonCount = (html.match(/<button[^>]*>/gi) || []).length;
  if (buttonCount < 2) {
    issues.push(`Tombol toggle bahasa tidak lengkap (ditemukan ${buttonCount}, seharusnya minimal 2).`);
  }

  const idDiv = extractDiv(html, "indonesian-version");
  const enDiv = extractDiv(html, "english-version");

  if (!idDiv) {
    issues.push('Div id="indonesian-version" tidak ditemukan.');
  } else {
    const words = wordCount(stripHtml(idDiv));
    if (words < MIN_WORDS_PER_LANGUAGE) {
      issues.push(`Konten versi Indonesia terlalu pendek (${words} kata, minimal ${MIN_WORDS_PER_LANGUAGE}).`);
    }
  }

  if (!enDiv) {
    issues.push('Div id="english-version" tidak ditemukan.');
  } else {
    const words = wordCount(stripHtml(enDiv));
    if (words < MIN_WORDS_PER_LANGUAGE) {
      issues.push(`Konten versi Inggris terlalu pendek (${words} kata, minimal ${MIN_WORDS_PER_LANGUAGE}).`);
    }
  }

  return { ok: issues.length === 0, issues };
}
