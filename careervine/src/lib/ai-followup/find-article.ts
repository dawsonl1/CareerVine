/**
 * Search → Evaluate → Loop: finds an article that would genuinely
 * resonate with the contact based on their interests.
 *
 * Iterates through interests and search results until it finds
 * something worth sharing, or falls back gracefully.
 */

import OpenAI from "openai";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import { searchNews, searchWeb, type SerperResult } from "@/lib/serper";
import type { Interest, ExtractedInterests } from "./extract-interests";

export interface ArticleResult {
  interest: Interest;
  article: {
    title: string;
    url: string;
    snippet: string;
    source: string;
  };
}

// Loop limits per the plan
const MAX_TOPICS = 3;
const MAX_ARTICLES_PER_TOPIC = 3;

const EVAL_SYSTEM_PROMPT = `You are helping someone reconnect with a professional contact by sharing a relevant article. Evaluate whether this article would make a genuinely thoughtful follow-up.`;

function buildEvalPrompt(interest: Interest, result: SerperResult): string {
  return `The contact expressed interest in: ${interest.topic}
Evidence: "${interest.evidence}"

Candidate article:
- Title: ${result.title}
- Source: ${result.source}
- Snippet: ${result.snippet}
- URL: ${result.url}

Would sharing this article feel genuinely thoughtful and natural?

Evaluate:
1. Is this specifically relevant to what they mentioned, not just vaguely related?
2. Is the source credible and the content substantive?
3. Would a real person actually forward this to a friend?
4. Is this too generic (e.g., "10 tips for..." listicle) or too niche?

Return JSON: { "verdict": "send" or "skip", "reason": "brief explanation" }`;
}

/**
 * Validate that a URL is a well-formed https:// URL.
 * Rejects javascript:, data:, and non-HTTPS schemes.
 */
function isValidArticleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Ask the LLM whether a specific article is worth sharing.
 */
async function evaluateArticle(
  openai: OpenAI,
  model: string,
  interest: Interest,
  result: SerperResult,
): Promise<boolean> {
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: EVAL_SYSTEM_PROMPT },
      { role: "user", content: buildEvalPrompt(interest, result) },
    ],
    response_format: {
      type: "json_schema" as const,
      json_schema: {
        name: "article_evaluation",
        strict: true,
        schema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["send", "skip"] },
            reason: { type: "string" },
          },
          required: ["verdict", "reason"],
          additionalProperties: false,
        },
      },
    },
    max_tokens: 300,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return false;

  const parsed = JSON.parse(content);
  return parsed.verdict === "send";
}

/**
 * Search for articles about a specific interest topic.
 * Tries news first, then web search as fallback.
 */
async function searchForTopic(query: string): Promise<SerperResult[]> {
  // Try news first — recent articles feel most natural to share
  try {
    const newsResults = await searchNews(query, 5);
    const validNews = newsResults.filter((r) => isValidArticleUrl(r.url));
    if (validNews.length > 0) return validNews;
  } catch {
    // News endpoint failed, fall through to web search
  }

  // Fall back to web search
  try {
    const webResults = await searchWeb(query, 5);
    return webResults.filter((r) => isValidArticleUrl(r.url));
  } catch {
    return [];
  }
}

/**
 * Main loop: iterate through interests and articles until a good one is found.
 *
 * Returns the best article and the interest it matches, or null if nothing
 * passed evaluation.
 */
export async function findArticle(
  extracted: ExtractedInterests,
): Promise<ArticleResult | null> {
  const openai = getOpenAIClient();
  const model = DEFAULT_MODEL;

  // Combine interests + profile fallbacks, interests first
  const allTopics = [
    ...extracted.interests.slice(0, MAX_TOPICS),
    ...extracted.profileFallbacks.slice(0, MAX_TOPICS - Math.min(extracted.interests.length, MAX_TOPICS)),
  ].slice(0, MAX_TOPICS);

  let totalEvals = 0;
  const MAX_TOTAL_EVALS = 8;

  for (const interest of allTopics) {
    const results = await searchForTopic(interest.searchQuery);

    for (const result of results.slice(0, MAX_ARTICLES_PER_TOPIC)) {
      if (totalEvals >= MAX_TOTAL_EVALS) break;
      totalEvals++;

      try {
        const isGood = await evaluateArticle(openai, model, interest, result);
        if (isGood) {
          return {
            interest,
            article: {
              title: result.title,
              url: result.url,
              snippet: result.snippet,
              source: result.source,
            },
          };
        }
      } catch {
        // Evaluation failed for this article, try next
        continue;
      }
    }

    if (totalEvals >= MAX_TOTAL_EVALS) break;
  }

  return null;
}
