/**
 * Shared OpenAI client factory.
 *
 * Centralizes API key handling and default model configuration
 * so every call site doesn't repeat the same setup.
 */

import OpenAI from "openai";
import { ApiError } from "@/lib/api-handler";

let cachedClient: OpenAI | null = null;

/**
 * Returns a shared OpenAI client instance.
 * Throws a friendly ApiError if the API key is not configured.
 */
export function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ApiError("OpenAI API key not configured", 500);
  }

  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

/** Default model for AI features. Reads OPENAI_MODEL env var with fallback. */
export const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-5-mini";
