/**
 * Serper API client for web and news search.
 * https://serper.dev/
 *
 * Used by the AI follow-up pipeline to find articles
 * relevant to a contact's interests.
 */

export interface SerperResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
  date?: string;
}

interface SerperNewsItem {
  title: string;
  link: string;
  snippet: string;
  source: string;
  date?: string;
}

interface SerperOrganicItem {
  title: string;
  link: string;
  snippet: string;
}

interface SerperNewsResponse {
  news?: SerperNewsItem[];
}

interface SerperSearchResponse {
  organic?: SerperOrganicItem[];
}

function getApiKey(): string {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY environment variable is not set");
  return key;
}

/**
 * Search for recent news articles via Serper /news endpoint.
 * Returns timely articles that feel natural to share.
 */
export async function searchNews(
  query: string,
  num: number = 5,
): Promise<SerperResult[]> {
  const response = await fetch("https://google.serper.dev/news", {
    method: "POST",
    headers: {
      "X-API-KEY": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Serper news search failed: ${response.status} ${response.statusText}`);
  }

  const data: SerperNewsResponse = await response.json();

  return (data.news || []).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    source: item.source,
    date: item.date,
  }));
}

/**
 * Search via Serper /search endpoint (Google organic results).
 * Fallback when news results are weak.
 */
export async function searchWeb(
  query: string,
  num: number = 5,
): Promise<SerperResult[]> {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Serper web search failed: ${response.status} ${response.statusText}`);
  }

  const data: SerperSearchResponse = await response.json();

  return (data.organic || []).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
    source: new URL(item.link).hostname.replace("www.", ""),
  }));
}
