/**
 * Shared per-user rate limiting (CAR-41, generalized from the CAR-13 MCP limiter).
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set;
 * degrades to allow-all (logged once) when they are absent.
 */

import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { trackServer } from "@/lib/analytics/server";

export type RateLimitWindow = Parameters<typeof Ratelimit.slidingWindow>[1];

export interface RateLimitOptions {
  /** Upstash key prefix — namespaces this limit's counters in Redis. */
  bucket: string;
  limit: number;
  window: RateLimitWindow;
  /**
   * CAR-143 (R5.3): buckets that gate real spend (shared-key AI) fail CLOSED
   * in production — a missing or erroring limiter denies instead of allowing.
   * Non-production keeps the allow-all degrade so local dev works without
   * Redis.
   */
  failClosed?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the window resets; null when the limiter is disabled. */
  resetAt: number | null;
}

let redis: Redis | null | undefined;
const limiters = new Map<string, Ratelimit>();
/** Buckets that have already emitted the fail-open guardrail (once per process). */
const degradedBuckets = new Set<string>();

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // Error-level (CAR-149): a missing limiter silently removes protection from
    // every fail-open bucket. Loud so a misconfigured deploy is not invisible.
    console.error("[rate-limit] Upstash env vars not set — rate limiting disabled (fail-open buckets are unthrottled)");
    redis = null;
    return null;
  }
  redis = Redis.fromEnv();
  return redis;
}

/**
 * Fire the fail-open guardrail once per bucket (CAR-149): a protected route lost
 * its limiter and is now unthrottled. Fire-and-forget under a system distinct id
 * (no acting user), mirroring trackCronError; never blocks or throws.
 */
function reportDegradeOnce(bucket: string): void {
  if (degradedBuckets.has(bucket)) return;
  degradedBuckets.add(bucket);
  void trackServer("system:rate-limit", "rate_limit_degraded", { bucket }).catch(() => {});
}

function getLimiter(options: RateLimitOptions): Ratelimit | null {
  const client = getRedis();
  if (!client) return null;

  let limiter = limiters.get(options.bucket);
  if (!limiter) {
    limiter = new Ratelimit({
      redis: client,
      limiter: Ratelimit.slidingWindow(options.limit, options.window),
      prefix: options.bucket,
    });
    limiters.set(options.bucket, limiter);
  }
  return limiter;
}

export async function checkRateLimit(
  userId: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  const failClosed = Boolean(options.failClosed) && process.env.NODE_ENV === "production";

  const limiter = getLimiter(options);
  if (!limiter) {
    if (failClosed) {
      console.error(`[rate-limit] no limiter for fail-closed bucket ${options.bucket} — denying`);
      return { allowed: false, remaining: 0, resetAt: null };
    }
    // Fail open: allowed through with no limit. Surface it as a guardrail so a
    // misconfigured Upstash doesn't quietly strip protection off this bucket.
    reportDegradeOnce(options.bucket);
    return { allowed: true, remaining: options.limit, resetAt: null };
  }

  try {
    const { success, remaining, reset } = await limiter.limit(userId);
    return { allowed: success, remaining, resetAt: reset };
  } catch (err) {
    // Fail-open buckets keep the original throw (surfaces as a 500);
    // fail-closed buckets deny rather than let Redis trouble open the wallet.
    if (failClosed) {
      console.error(`[rate-limit] limiter error on fail-closed bucket ${options.bucket} — denying:`, err);
      return { allowed: false, remaining: 0, resetAt: null };
    }
    throw err;
  }
}

/** @internal Test hook */
export function resetRateLimitersForTests(): void {
  redis = undefined;
  limiters.clear();
  degradedBuckets.clear();
}
