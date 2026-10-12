function extractField(text, label) {
  // Tolerates "Label:", "**Label:**", leading "- ", etc.
  const re = new RegExp(`^[\\s\\-*]*${label}\\s*:?\\**\\s*(.+)$`, "im");
  const match = text.match(re);
  return match ? match[1].trim() : "";
}

function extractFencedBlock(text) {
  // Grabs the first fenced code block, optionally tagged ```html
  const match = text.match(/```(?:html)?\s*\n([\s\S]*?)\n```/i);
  return match ? match[1].trim() : "";
}

export function parseGeminiArticleResponse(rawText) {
  const bagianAIndex = rawText.search(/#\s*BAGIAN A/i);
  const bagianBIndex = rawText.search(/#\s*BAGIAN B/i);

  if (bagianAIndex === -1 || bagianBIndex === -1 || bagianBIndex <= bagianAIndex) {
    throw new Error("Could not locate both BAGIAN A and BAGIAN B sections in Gemini's response.");
  }

  const sectionA = rawText.slice(bagianAIndex, bagianBIndex);
  const sectionB = rawText.slice(bagianBIndex);

  const meta = {
    category: extractField(sectionA, "Kategori"),
    searchIntent: extractField(sectionA, "Search Intent"),
    targetKeyword: extractField(sectionA, "Target Keyword Utama"),
    lsiKeywords: extractField(sectionA, "Keyword Turunan \\(LSI\\)"),
    titleEn: extractField(sectionA, "Judul Artikel"),
    metaDescription: extractField(sectionA, "Meta Description"),
    altText: extractField(sectionA, "Alt Text Gambar Utama"),
    thumbnailPrompt: extractField(sectionA, "Prompt Thumbnail"),
    internalLinkSuggestions: extractField(sectionA, "Saran Internal Link"),
  };

  const html = extractFencedBlock(sectionB);

  return { meta, html };
}
