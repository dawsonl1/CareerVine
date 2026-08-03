/**
 * School-change side effects on bundle subscriptions (CAR-213).
 *
 * Exactly one direction does anything:
 *
 *   NO AFFINITY → AFFINITY  the user now qualifies for the alumni-only
 *                           prospects their subscriptions skipped. Reset
 *                           synced_version to 0 and clear the checkpoint, and
 *                           the next sync re-walks the bundle from the start
 *                           and fills in what was withheld. This is the exact
 *                           mechanism resubscribe already uses ("Reset to 0 on
 *                           resubscribe (idempotent full re-apply)"), so the
 *                           top-up rides machinery that is already proven,
 *                           and the apply path is idempotent — prospects the
 *                           user already has merge rather than duplicate.
 *
 *   AFFINITY → NO AFFINITY  NOTHING. Deliberately. The contacts they already
 *                           hold are theirs, and deleting real contact data
 *                           because someone edited a profile field is not a
 *                           defensible behaviour. Highlighting disappears
 *                           because it is computed at read time; the people
 *                           stay. A user who genuinely wants them gone has the
 *                           unsubscribe flow, which asks properly.
 *
 * No-op for anything that does not cross the boundary, including a switch
 * between two different non-BYU schools.
 */

import { createSupabaseBrowserClient } from "@/lib/supabase/browser-client";
import { hasAlumniAffinity } from "./affinity";

export type AffinityTransition = "gained" | "lost" | "unchanged";

/** Which way, if either, a school edit crosses the affinity boundary. */
export function affinityTransition(
  previous: string | null | undefined,
  next: string | null | undefined,
): AffinityTransition {
  const before = hasAlumniAffinity(previous);
  const after = hasAlumniAffinity(next);
  if (before === after) return "unchanged";
  return after ? "gained" : "lost";
}

/**
 * Queue a full re-apply of every active subscription so the previously-skipped
 * alumni land. Returns the number of subscriptions reset.
 *
 * Best-effort by design: the caller has already saved the profile, and the
 * daily sync cron is a safety net that picks these up regardless. Failing the
 * save because a top-up could not be *queued* would be the worse outcome.
 */
export async function resyncBundlesForAffinityGain(userId: string): Promise<number> {
  const supabase = createSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("bundle_subscriptions")
    .update({ synced_version: 0, sync_cursor: null })
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
