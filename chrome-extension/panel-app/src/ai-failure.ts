// ── AI-availability failures (CAR-26) ──────────────────────────────────
// Extension-local mirror of the web app's lib/ai-errors.ts copy map — the two
// projects share no bundle, so keep wording identical to AI_FAILURE_COPY there.
// All codes arrive over HTTP 402 from /api/extension/parse-profile.

export type AiFailureCode =
  | "ai_no_key"
  | "ai_key_invalid"
  | "ai_quota_exhausted"
  | "ai_trial_expired"
  | "ai_unavailable";

const AI_FAILURE_CODES: AiFailureCode[] = [
  "ai_no_key",
  "ai_key_invalid",
  "ai_quota_exhausted",
  "ai_trial_expired",
  "ai_unavailable",
];

export const AI_FAILURE_COPY: Record<AiFailureCode, { title: string; body: string; ctaLabel: string; retryable: boolean }> = {
  ai_no_key: {
    title: "Add your OpenAI key to use AI",
    body: "CareerVine's AI features need an OpenAI key. Add yours in Settings — with OpenAI's free daily tokens, most people pay nothing.",
    ctaLabel: "Add your key",
    retryable: false,
  },
  ai_key_invalid: {
    title: "Your OpenAI key was rejected",
    body: "OpenAI didn't accept your key. Update it in Settings to keep using AI features.",
    ctaLabel: "Update key",
    retryable: false,
  },
  ai_quota_exhausted: {
    title: "Your OpenAI key is out of quota",
    body: "Your key hit its usage limit. Add credit or turn on free daily tokens in your OpenAI account, then try again.",
    ctaLabel: "Manage key",
    retryable: false,
  },
  ai_trial_expired: {
    // The request-access button lives on the web app's Settings → AI page —
    // the CTA sends the user there rather than duplicating the flow here.
    title: "Your free AI day has ended",
    body: "Your 24-hour AI trial is over. Add your own OpenAI key in Settings — or request continued access from the AI settings page.",
    ctaLabel: "Open AI settings",
    retryable: false,
  },
  ai_unavailable: {
    title: "AI is temporarily unavailable",
    body: "We couldn't reach AI right now. Try again in a moment — or add your own OpenAI key so this never blocks you.",
    ctaLabel: "Add your key",
    retryable: true,
  },
};

/** Mirror of the web app's parseAiFailure: 402 → known code, or ai_unavailable
 * as the defensive default; any other status is not an AI-availability failure. */
export function mapAiFailure(status: unknown, code: unknown): AiFailureCode | null {
  if (status !== 402) return null;
  return AI_FAILURE_CODES.includes(code as AiFailureCode) ? (code as AiFailureCode) : "ai_unavailable";
}
