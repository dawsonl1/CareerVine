/**
 * Account-status guard for server-side automation.
 *
 * Suspension freezes an account: GoTrue's ban blocks login/refresh, and this
 * helper keeps crons (scheduled emails, follow-ups, bundle sync) from acting
 * on a suspended user's behalf. Work is HELD, not dropped — pending rows stay
 * pending and resume when the account is reactivated.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Return the subset of userIds whose account status is 'active'. */
export async function filterActiveUserIds(
  service: SupabaseClient,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const { data, error } = await service
    .from("users")
    .select("id")
    .in("id", userIds)
    .eq("status", "active");

  if (error) {
    // Fail open: a broken guard must not silently freeze every user's sends.
    console.error(`[user-status] active-filter failed, treating all as active: ${error.message}`);
    return new Set(userIds);
  }

  return new Set(((data as Array<{ id: string }>) ?? []).map((r) => r.id));
}
