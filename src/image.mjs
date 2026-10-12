// Builds a free, no-API-key image URL via Pollinations.ai. The URL itself IS
// the image (generated on first request, then cached by their CDN), so it can
// be hotlinked directly as an <img src> in the Blogger post — no separate
// image hosting/upload step needed.
export function buildThumbnailUrl(prompt, { width = 1200, height = 675 } = {}) {
  const seed = Math.floor(Math.random() * 1_000_000);
  const encoded = encodeURIComponent(prompt.trim());
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${seed}`;
}

export function imgTag(url, alt) {
  const safeAlt = alt.replace(/"/g, "&quot;");
  return `<img src="${url}" alt="${safeAlt}" style="max-width:100%;height:auto;display:block;margin:0 auto 16px auto;" />`;
}
