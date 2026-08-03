/**
 * Server-side affinity resolution for the bundle sync (CAR-213).
 *
 * Reads public.users.university, which is CANONICAL. Deliberately not the
 * `user_metadata.university` mirror that the client hook uses: a user can
 * write their own auth metadata through the Supabase client, so trusting it
 * here would let anyone grant themselves the alumni-only prospects by editing
 * a JWT claim.
 *
 * Resolved inside applyBundleDelta rather than threaded in by each caller.
 * There are four sync drivers (user-driven apply, QStash fan-out worker, daily
 * cron, Settings opportunistic self-sync) and a driver that forgot to pass the
 * flag would silently deliver the wrong database — a failure with no symptom
 * until a user notices contacts they should not have. One extra single-row
 * read per chunk (~14 over a full 2,000-prospect sync) buys
 * correctness-by-construction, which is the right trade at that price.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { hasAlumniAffinity } from "./affinity";

/**
 * Does this subscriber receive the alumni-only prospects?
 *
 * FAILS CLOSED on a missing row: no user row means no claimed school, which is
 * the no-affinity state. Note this is NOT a fail-safe/fail-dangerous choice in
 * the usual sense — withholding is the conservative direction for data the
 * user may not be entitled to, and the daily sync re-runs, so a transient miss
 * self-heals on the next pass rather than persisting.
 */
export async function resolveSubscriberAffinity(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("users")
    .select("university")
    .eq("id", userId)
    .maybeSingle();
  // Fail loud: a swallowed read here would silently hand every subscriber the
  // non-affinity database, including real BYU users, and nothing downstream
  // could tell that apart from a correct answer.
  if (error) throw new Error(`Affinity read failed for user ${userId}: ${error.message}`);
  return hasAlumniAffinity((data as { university: string | null } | null)?.university);
}
