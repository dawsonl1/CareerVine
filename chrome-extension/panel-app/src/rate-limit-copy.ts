/**
 * Copy for the hourly import rate limit (CAR-41). Pure helper so the wording
 * and minutes math are unit-testable from the careervine Vitest suite.
 */

/** Detects the API's 429 `{ code: "rate_limited" }` response. */
export function isRateLimited(status: unknown, code: unknown): boolean {
  return status === 429 && code === "rate_limited";
}

/**
 * `resetAt` is epoch ms of the window reset (null/undefined when the server
 * couldn't say — fall back to generic wording). Minutes are rounded up with a
 * minimum of 1 so the copy never says "0 minutes".
 */
export function rateLimitedCopy(resetAt: unknown, now: number = Date.now()): string {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
    return "You've hit the hourly import limit — try again in a bit.";
  }
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  return `You've hit the hourly import limit — try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}
