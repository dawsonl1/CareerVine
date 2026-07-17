/**
 * LLM Call #1: Extract personal and professional interests from contact context.
 *
 * Uses OpenAI structured outputs to guarantee valid JSON.
 */

import { DEFAULT_MODEL, type OpenAIRunner } from "@/lib/openai";
import { parseModelJson } from "@/lib/ai/model-json";
import { UNTRUSTED_DATA_CLAUSE } from "@/lib/ai/untrusted";
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
Do NOT fabricate interests — only extract what is clearly supported by the context.

${UNTRUSTED_DATA_CLAUSE}`;

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
  runAI: OpenAIRunner,
): Promise<ExtractedInterests> {
  const model = DEFAULT_MODEL;

  const formattedContext = formatContextForLLM(context);

  const response = await runAI((openai) =>
    openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: formattedContext },
      ],
      response_format: RESPONSE_SCHEMA,
      max_tokens: 2000,
    }),
  );

  // Missing, truncated, malformed, or wrong-shaped output all degrade to
  // empty results — this path must never throw (CAR-143, R5.4).
  const parsed = parseModelJson(response.choices[0]?.message?.content) as
    | Partial<ExtractedInterests>
    | null;

  const interests = Array.isArray(parsed?.interests) ? parsed.interests : [];
  const profileFallbacks = Array.isArray(parsed?.profileFallbacks)
    ? parsed.profileFallbacks
    : [];

  // Sort by confidence descending (tolerating non-numeric confidence values)
  const byConfidence = (a: Interest, b: Interest) =>
    (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0);
  interests.sort(byConfidence);
  profileFallbacks.sort(byConfidence);

  return { interests, profileFallbacks };
}
