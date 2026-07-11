/**
 * Internal-account exclusion (CAR-60, reworked in CAR-80): Dawson's own accounts and test
 * accounts must not pollute product analytics.
 *
 * "Internal" is now email-derived in the database — the @careervine.app domain plus an
 * allowlist (see migration 20260711180000) — and mirrored onto auth.users.app_metadata as
 * an `is_internal` JWT claim. The web client and extension read that claim straight off the
 * session User object (synchronous, no fetch). The server only ever has a user id, so it
 * resolves the flag through the user_is_internal() SECURITY DEFINER function and caches the
 * answer per process (a user's internal status is immutable for a runtime's lifetime).
 *
 * Because this reads through the service-role client, it must NEVER be imported into the
 * browser bundle — the client checks user.app_metadata.is_internal directly instead.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cache = new Map<string, boolean>();
let client: ReturnType<typeof createSupabaseServiceClient> | null = null;

function svc() {
  if (!client) client = createSupabaseServiceClient();
  return client;
}

/**
 * True when this user's activity must be excluded from analytics. Resolves the
 * email-derived flag from the database (cached per process). Never throws — analytics must
 * not add a failure mode — and returns false for non-user distinct ids (e.g. the
 * "system:cron" id used by trackCronError) without touching the database.
 */
export async function isInternalUser(
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId || !UUID_RE.test(userId)) return false;
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  try {
    const { data, error } = await svc().rpc("user_is_internal", { uid: userId });
    if (error) return false; // transient failure — don't cache, retry next call
    const internal = data === true;
    cache.set(userId, internal);
    return internal;
  } catch {
    return false; // never break the caller; don't cache so it can retry
  }
}

/** Test seam: clear the per-process cache and memoized client. */
export function _resetInternalUsersForTests(): void {
  cache.clear();
  client = null;
}
