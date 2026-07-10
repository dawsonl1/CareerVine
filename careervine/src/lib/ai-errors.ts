/**
 * CAR-26 — the single source of truth for AI-availability failures.
 *
 * This module is intentionally CLIENT-SAFE: it imports nothing server-only, so
 * feature components can import the copy map and `parseAiFailure` without pulling
 * `api-handler` (which touches `next/server`) into the browser bundle. The
 * server-side `AiUnavailableError` that throws these codes lives in `lib/openai.ts`.
 *
 * All four failures are emitted over HTTP 402 (unused elsewhere in the app), so a
 * client can fast-path on the status and branch on `code`.
 */

/** The closed set of AI-availability failure causes. */
export type AiFailureCode =
  | "ai_no_key" // no personal key AND no shared access
  | "ai_key_invalid" // personal key rejected (401), no shared access
  | "ai_quota_exhausted" // personal key out of quota, no shared access
  | "ai_trial_expired" // 24h shared-AI trial ended, no personal key (CAR-51)
  | "ai_unavailable"; // shared key failing / not configured, or provider outage (incl. Deepgram)

/** HTTP status every AI-availability failure is emitted with. */
export const AI_UNAVAILABLE_STATUS = 402;

export interface AiFailureCopy {
  /** Short headline shown in the feature UI. */
  title: string;
  /** One or two sentences: what happened + what to do. */
  body: string;
  /** Primary call-to-action label. */
  ctaLabel: string;
  /** Where the CTA links (the Settings → AI tab). */
  ctaHref: string;
  /** Whether a retry can plausibly succeed without user action. */
  retryable: boolean;
  /**
   * Message used as the thrown ApiError's `.message` server-side. Kept generic
   * and secret-free — the client renders its own copy from this map, not this
   * string, but it still lands in logs.
   */
  serverMessage: string;
}

const SETTINGS_AI_HREF = "/settings?tab=ai";

export const AI_FAILURE_COPY: Record<AiFailureCode, AiFailureCopy> = {
  ai_no_key: {
    title: "Add your OpenAI key to use AI",
    body: "CareerVine's AI features need an OpenAI key. Add yours in Settings — with OpenAI's free daily tokens, most people pay nothing.",
    ctaLabel: "Add your key",
    ctaHref: SETTINGS_AI_HREF,
    retryable: false,
    serverMessage: "No OpenAI key available for this account",
  },
  ai_key_invalid: {
    title: "Your OpenAI key was rejected",
    body: "OpenAI didn't accept your key. Update it in Settings to keep using AI features.",
    ctaLabel: "Update key",
    ctaHref: SETTINGS_AI_HREF,
    retryable: false,
    serverMessage: "OpenAI key was rejected",
  },
  ai_quota_exhausted: {
    title: "Your OpenAI key is out of quota",
    body: "Your key hit its usage limit. Add credit or turn on free daily tokens in your OpenAI account, then try again.",
    ctaLabel: "Manage key",
    ctaHref: SETTINGS_AI_HREF,
    retryable: false,
    serverMessage: "OpenAI key has no remaining quota",
  },
  ai_trial_expired: {
    title: "Your free AI day has ended",
    body: "Your 24-hour AI trial is over. Add your own OpenAI key to keep using AI — or request continued access and we'll follow up by email.",
    ctaLabel: "Add your key",
    ctaHref: SETTINGS_AI_HREF,
    retryable: false,
    serverMessage: "Shared AI trial has expired",
  },
  ai_unavailable: {
    title: "AI is temporarily unavailable",
    body: "We couldn't reach AI right now. Try again in a moment — or add your own OpenAI key so this never blocks you.",
    ctaLabel: "Add your key",
    ctaHref: SETTINGS_AI_HREF,
    retryable: true,
    serverMessage: "AI is temporarily unavailable",
  },
};

const AI_FAILURE_CODES = Object.keys(AI_FAILURE_COPY) as AiFailureCode[];

/** Narrowing guard: is `value` one of the known AI failure codes? */
export function isAiFailureCode(value: unknown): value is AiFailureCode {
  return typeof value === "string" && (AI_FAILURE_CODES as string[]).includes(value);
}

/**
 * Given a fetch response status and its parsed JSON body, returns the AI failure
 * code if this was an AI-availability failure, else null. This is the ONLY place
 * the client inspects a response for AI failures — no message string-matching.
 *
 * A 402 without a recognized `code` is treated as `ai_unavailable` (defensive:
 * some proxy or an older server shape shouldn't strand the user without a state).
 */
export function parseAiFailure(status: number, data: unknown): AiFailureCode | null {
  if (status !== AI_UNAVAILABLE_STATUS) return null;
  const code = (data as { code?: unknown } | null)?.code;
  return isAiFailureCode(code) ? code : "ai_unavailable";
}
