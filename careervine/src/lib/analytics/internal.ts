/**
 * Internal-account exclusion (CAR-60): Dawson's own accounts (and future
 * test accounts) must not pollute product analytics.
 *
 * The id list lives in NEXT_PUBLIC_ANALYTICS_INTERNAL_USER_IDS
 * (comma-separated Supabase user ids) — NEXT_PUBLIC so the same check works
 * in the browser bundle, server routes, cron, and both MCP processes. User
 * ids are opaque UUIDs, so shipping them in the bundle leaks nothing.
 *
 * Adding a test account = append its id to the Vercel env var (+ redeploy)
 * and $set is_internal on its PostHog person. No code change.
 */

let cached: Set<string> | null = null;

export function internalUserIds(): Set<string> {
  if (cached) return cached;
  cached = new Set(
    (process.env.NEXT_PUBLIC_ANALYTICS_INTERNAL_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return cached;
}

/** True when this user's activity must be excluded from analytics. */
export function isInternalUser(userId: string | null | undefined): boolean {
  return !!userId && internalUserIds().has(userId);
}

/** Test seam: clear the parsed-env cache. */
export function _resetInternalUsersForTests(): void {
  cached = null;
}
