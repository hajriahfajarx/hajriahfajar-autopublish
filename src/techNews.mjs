// Free, no-API-key source of "what's actually happening in tech right now":
// public RSS feeds from well-known tech news outlets. Used for the morning
// window instead of Gemini's Google Search grounding tool, which turned out
// to require billing enabled on Gemini 3.x (no free tier) -- RSS is zero
// cost and zero setup.
const FEEDS = [
  "https://techcrunch.com/feed/",
  "https://www.theverge.com/rss/index.xml",
  "https://feeds.arstechnica.com/arstechnica/index",
];

function decodeEntities(str) {
  return (str || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();
}

function stripHtml(str) {
  return (str || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseRssItems(xml, sourceName) {
  const items = [];
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = decodeEntities((block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = decodeEntities((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1]);
    const descriptionRaw = (block.match(/<description>([\s\S]*?)<\/description>/i) || [])[1];
    const description = stripHtml(decodeEntities(descriptionRaw)).slice(0, 400);
    const pubDate = decodeEntities((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    if (title && link) {
      items.push({ title, link, description, pubDate, source: sourceName, publishedAt: pubDate ? new Date(pubDate) : null });
    }
  }
  return items;
}

async function fetchFeed(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; hajriahfajar-autopublish/1.0)" } });
    if (!res.ok) {
      console.warn(`Feed fetch failed (${res.status}): ${url}`);
      return [];
    }
    const xml = await res.text();
    return parseRssItems(xml, new URL(url).hostname);
  } catch (err) {
    console.warn(`Feed fetch error for ${url}: ${err.message}`);
    return [];
  }
}

/**
 * Fetches the latest items from all configured tech news RSS feeds, merges
 * and sorts them by publish date (newest first). Free, no API key.
 */
export async function fetchLatestTechNews() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = results.flat();
  all.sort((a, b) => (b.publishedAt?.getTime() || 0) - (a.publishedAt?.getTime() || 0));
  return all;
}

function normalize(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Filters out news items whose title closely matches anything already
 * covered in pastLog, so candidates passed to Gemini don't repeat past
 * topics. Does NOT judge suitability/appropriateness -- that's left to
 * Gemini (see pickTrendingTopic in gemini.mjs), since a plain recency sort
 * can surface items unsuitable for the blog (crime, disturbing content,
 * pure politics/legal drama) that need human-like judgment to filter out.
 */
export function filterUncoveredNewsItems(newsItems, pastLog, limit = 20) {
  const pastTitles = pastLog.map((r) => normalize(r.titleEn) || normalize(r.titleId));
  return newsItems
    .filter((item) => {
      const n = normalize(item.title);
      return !pastTitles.some((p) => p && (n.includes(p) || p.includes(n)));
    })
    .slice(0, limit);
}
