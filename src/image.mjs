export function imgTag(url, alt) {
  const safeAlt = alt.replace(/"/g, "&quot;");
  return `<img src="${url}" alt="${safeAlt}" style="max-width:100%;height:auto;display:block;margin:0 auto 16px auto;" />`;
}
