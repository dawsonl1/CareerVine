/**
 * LLM Call #1: Extract personal and professional interests from contact context.
 *
 * Uses OpenAI structured outputs to guarantee valid JSON.
 */

import OpenAI from "openai";
import { formatContextForLLM, type ContactContext } from "./gather-context";

export interface Interest {
  topic: string;
  evidence: string;
  source: string;
  confidence: number;
  searchQuery: string;
}

export interface ExtractedInterests {
  interests: Interest[];
  profileFallbacks: Interest[];
}

const SYSTEM_PROMPT = `You are analyzing conversation history with a professional contact to find topics for a thoughtful follow-up email.

Extract personal interests, hobbies, topics from small talk, or anything they mentioned being passionate about outside of work. Also extract professional interests that could be relevant: their industry trends, company news angles, career interests.

For each interest found, provide:
- topic: A short label for the interest
- evidence: A direct quote or paraphrase from the conversation
- source: Which meeting or interaction it came from (include date if available)
- confidence: How clearly they expressed interest (0.0 to 1.0)
- searchQuery: A generic search query to find articles about this topic. NEVER include the person's name, company name, or any identifying information in the search query. Keep it abstract.

If no meetings, transcripts, or notes exist, derive interests from their profile: industry trends, role-specific topics, or education-related content.

Return interests sorted by confidence (highest first).
Do NOT fabricate interests — only extract what is clearly supported by the context.`;

const INTEREST_ITEM_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string" },
    evidence: { type: "string" },
    source: { type: "string" },
    confidence: { type: "number" },
    searchQuery: { type: "string" },
  },
  required: ["topic", "evidence", "source", "confidence", "searchQuery"],
  additionalProperties: false,
} as const;

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "extracted_interests",
    strict: true,
    schema: {
      type: "object",
      properties: {
        interests: { type: "array", items: INTEREST_ITEM_SCHEMA },
        profileFallbacks: { type: "array", items: INTEREST_ITEM_SCHEMA },
      },
      required: ["interests", "profileFallbacks"],
      additionalProperties: false,
    },
  },
};

export async function extractInterests(
  context: ContactContext,
): Promise<ExtractedInterests> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

  const formattedContext = formatContextForLLM(context);

  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: formattedContext },
    ],
    response_format: RESPONSE_SCHEMA,
    max_tokens: 2000,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    return { interests: [], profileFallbacks: [] };
  }

  const parsed: ExtractedInterests = JSON.parse(content);

  // Sort by confidence descending
  parsed.interests.sort((a, b) => b.confidence - a.confidence);
  parsed.profileFallbacks.sort((a, b) => b.confidence - a.confidence);

  return parsed;
}
