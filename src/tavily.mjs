// Thin wrapper around Tavily's search API (https://tavily.com) — used to
// ground topic-picking and article-writing in real, current web content
// instead of relying purely on Gemini's own (possibly stale) knowledge.
// Entirely OPTIONAL: every caller must treat a failure here as non-fatal
// and fall back to the Gemini-only behavior, since this is an enhancement,
// not a hard dependency (see run.mjs).

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

async function tavilySearch(apiKey, { query, topic = "general", days, maxResults = 5, includeAnswer = false }) {
  const body = {
    api_key: apiKey,
    query,
    topic,
    max_results: maxResults,
    include_answer: includeAnswer,
  };
  if (days) body.days = days;

  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return {
    answer: data.answer || "",
    results: (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      publishedDate: r.published_date || null,
    })),
  };
}

/**
 * Finds real, recent discussion/news material for a topic area — used
 * BEFORE picking a topic, so the model chooses from genuinely current
 * material instead of inventing something in a vacuum. `topic: "news"` +
 * `days` restricts results to recent coverage.
 */
export async function findTrending(apiKey, query, { days = 3, maxResults = 6 } = {}) {
  return tavilySearch(apiKey, { query, topic: "news", days, maxResults });
}

/**
 * Finds factual reference material for an ALREADY-CHOSEN topic/keyword —
 * used right before writing, so the article can cite accurate, current
 * facts instead of relying solely on the model's internal knowledge (which
 * can be stale or simply wrong on specifics).
 */
export async function findResearch(apiKey, query, { maxResults = 5 } = {}) {
  return tavilySearch(apiKey, { query, topic: "general", maxResults, includeAnswer: true });
}
