/**
 * Per-user MCP tool-call rate limiting (CAR-13).
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let limiter: Ratelimit | null | undefined;

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    limiter = null;
    return null;
  }
  limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(60, "1 m"),
    prefix: "careervine-mcp",
  });
  return limiter;
}

export async function checkMcpRateLimit(
  userId: string,
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const rl = getLimiter();
  if (!rl) return { ok: true };

  const { success, reset } = await rl.limit(userId);
  if (success) return { ok: true };
  return { ok: false, retryAfterMs: Math.max(0, reset - Date.now()) };
}

/** @internal Test hook */
export function resetMcpRateLimiterForTests(): void {
  limiter = undefined;
}
