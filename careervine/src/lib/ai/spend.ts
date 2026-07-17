/**
 * Shared-OpenAI-key spend accounting (CAR-143, R5.3) — modeled on the
 * fail-closed apify/spend.ts pattern.
 *
 * Persisted per-user monthly counter in ai_shared_usage, checked at the
 * OpenAIRunner chokepoint before every shared-key call and incremented after
 * each one. The reader fails CLOSED: a lookup error throws, and the caller
 * treats that as "ceiling reached" rather than spending against an unknown
 * balance (matching resolveSharedAccess's deny-on-error posture). BYO-key
 * calls never touch this.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

function positiveEnvNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Monthly ceiling on estimated shared-key spend per user. Small by design:
 * the shared key exists for the 24h trial and hand-granted access, not as an
 * unmetered pool. Override via SHARED_AI_SPEND_LIMIT_USD.
 */
export const SHARED_AI_SPEND_LIMIT_USD = positiveEnvNumber(
  process.env.SHARED_AI_SPEND_LIMIT_USD,
  1,
);

/**
 * Conservative per-call fallback when a response carries no usage block —
 * deliberately above the typical real cost so estimation errors shrink the
 * budget instead of stretching it.
 */
export const FLAT_CALL_COST_USD = 0.01;

/** gpt-5-mini list pricing (USD per token). Other models on the shared key
 * are close enough for a ceiling estimate — this is a fuse, not a ledger. */
const INPUT_COST_PER_TOKEN = 0.25 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 2 / 1_000_000;

type UsageLike = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
};

/**
 * Estimate what a completed call cost. Reads the usage block both API shapes
 * emit (Responses: input/output_tokens; Chat Completions:
 * prompt/completion_tokens); falls back to a conservative flat estimate.
 */
export function estimateCallCostUsd(result: unknown): number {
  const usage = (result as { usage?: UsageLike } | null | undefined)?.usage;
  if (usage && typeof usage === "object") {
    const input = Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
    const output = Number(usage.output_tokens ?? usage.completion_tokens) || 0;
    if (input > 0 || output > 0) {
      return input * INPUT_COST_PER_TOKEN + output * OUTPUT_COST_PER_TOKEN;
    }
  }
  return FLAT_CALL_COST_USD;
}

/** First day of the current UTC month, as the DATE string the table keys on. */
export function currentPeriodStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Month-to-date estimated shared-key spend for a user. Throws on query error
 * so the caller fails CLOSED (never treats an error as $0).
 */
export async function getSharedAiSpendUsd(userId: string): Promise<number> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("ai_shared_usage")
    .select("estimated_cost_usd")
    .eq("user_id", userId)
    .eq("period_start", currentPeriodStart())
    .maybeSingle();
  if (error) throw new Error(`shared AI spend lookup failed: ${error.message}`);
  return Number(data?.estimated_cost_usd ?? 0);
}

/**
 * Record spend after a shared-key call (atomic upsert-add via RPC).
 * Best-effort: a failed write is logged, never thrown — the call already
 * happened, and blocking the user's result wouldn't un-spend it. The ceiling
 * check reads persisted state, so a dropped increment only under-counts by
 * one call.
 */
export async function recordSharedAiSpend(userId: string, costUsd: number): Promise<void> {
  try {
    const service = createSupabaseServiceClient();
    const { error } = await service.rpc("increment_ai_shared_usage", {
      p_user_id: userId,
      p_period_start: currentPeriodStart(),
      p_cost: costUsd,
    });
    if (error) {
      console.error("[ai-spend] failed to record shared AI spend:", error.message);
    }
  } catch (err) {
    console.error("[ai-spend] failed to record shared AI spend:", err);
  }
}
