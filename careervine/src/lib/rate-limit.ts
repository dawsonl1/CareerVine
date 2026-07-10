/**
 * Shared per-user rate limiting (CAR-41, generalized from the CAR-13 MCP limiter).
 * Uses Upstash Redis when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set;
 * degrades to allow-all (logged once) when they are absent.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitWindow = Parameters<typeof Ratelimit.slidingWindow>[1];

export interface RateLimitOptions {
  /** Upstash key prefix — namespaces this limit's counters in Redis. */
  bucket: string;
  limit: number;
  window: RateLimitWindow;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Epoch ms when the window resets; null when the limiter is disabled. */
  resetAt: number | null;
}

let redis: Redis | null | undefined;
const limiters = new Map<string, Ratelimit>();

function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.warn("[rate-limit] Upstash env vars not set — rate limiting disabled");
    redis = null;
    return null;
  }
  redis = Redis.fromEnv();
  return redis;
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
  const limiter = getLimiter(options);
  if (!limiter) return { allowed: true, remaining: options.limit, resetAt: null };

  const { success, remaining, reset } = await limiter.limit(userId);
  return { allowed: success, remaining, resetAt: reset };
}

/** @internal Test hook */
export function resetRateLimitersForTests(): void {
  redis = undefined;
  limiters.clear();
}
