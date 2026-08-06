import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { paginateAll } from "@/lib/data/postgrest";
import { filterActiveUserIds } from "@/lib/user-status";
import { capabilitiesFor } from "@/lib/capabilities/map";
import { FollowUpStatus } from "@/lib/constants";

/**
 * Who and what the SCHEDULED Gmail syncs operate on (CAR-234).
 *
 * These run with no signed-in user, so nothing here can lean on RLS: every
 * query is explicitly scoped to a user id the caller resolved, and the service
 * client is passed in rather than reached for, so a test can hand it a double.
 */

/** Days of outbound history that make a contact "recently touched". */
export const RECENT_OUTBOUND_DAYS = 9;

/**
 * Users the scheduled syncs are allowed to touch: connected, not suspended, and
 * holding `mailbox:read`.
 *
 * `mailbox:read` is the capability, not the tier — gating on a tier is what
 * conventions §c exists to stop, and the free tier genuinely lacks the Gmail
 * scope this work needs, so a non-premium user here would 403 against Google
 * rather than merely doing something cheap.
 *
 * The three flags are read in one pass and resolved through `capabilitiesFor`,
 * the same prefetch shape `send-follow-ups` uses. `premium_enabled` defaults to
 * TRUE when null, matching that route: the column is an admin kill switch, and
 * treating its absence as "off" would silently strand every user predating it.
 */
export async function getPremiumSyncUserIds(service: SupabaseClient): Promise<string[]> {
  const connections = await paginateAll(async (from, to) => {
    const { data, error } = await service
      .from("gmail_connections")
      .select("user_id, modify_scope_granted, premium_enabled")
      .order("user_id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data ?? [];
  });

  const eligible = connections
    .filter((c) =>
      capabilitiesFor({
        modifyScopeGranted: c.modify_scope_granted ?? false,
        automaticFeaturesEnabled: false,
        premiumEnabled: c.premium_enabled ?? true,
        hasConnection: true,
      }).has("mailbox:read"),
    )
    .map((c) => c.user_id as string);

  if (eligible.length === 0) return [];

  // Suspended accounts are frozen rather than dropped, same as the send crons.
  const active = await filterActiveUserIds(service, eligible);
  return eligible.filter((id) => active.has(id));
}

/**
 * Contacts worth re-checking on the 20-minute cadence: those on a live
 * follow-up sequence, plus those we have written to inside
 * `RECENT_OUTBOUND_DAYS`.
 *
 * ── Why this set and not "everyone" ──────────────────────────────────────
 *
 * A reply can only land in a thread we started, so for the outreach loop this
 * set has the same recall as a full sweep at a fraction of the cost (~40
 * contacts against ~1,571 on a real account). What it deliberately misses is
 * cold inbound from someone we never emailed; the 3x-daily full sweep owns
 * that.
 *
 * ── Why both legs ────────────────────────────────────────────────────────
 *
 * Neither subsumes the other. A sequence can outlive the 9-day window (steps
 * run to day 13), and a one-off send with no sequence attached has no
 * follow-up row at all. `email_follow_ups.contact_id` is also nullable, so the
 * sequence leg silently drops rows that were never linked to a contact — the
 * outbound leg is what catches those.
 *
 * Returns a de-duplicated array. An EMPTY array means nothing qualifies, and
 * the caller must skip the user rather than pass it to `syncAllContactEmails`,
 * where `.in("id", [])` would match nothing and waste the pass.
 */
export async function getRecentlyTouchedContactIds(
  service: SupabaseClient,
  userId: string,
  days: number = RECENT_OUTBOUND_DAYS,
): Promise<number[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const sequenceRows = await paginateAll(async (from, to) => {
    const { data, error } = await service
      .from("email_follow_ups")
      .select("contact_id")
      .eq("user_id", userId)
      .eq("status", FollowUpStatus.Active)
      .not("contact_id", "is", null)
      .order("contact_id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data ?? [];
  });

  const outboundRows = await paginateAll(async (from, to) => {
    const { data, error } = await service
      .from("email_messages")
      .select("matched_contact_id")
      .eq("user_id", userId)
      .eq("direction", "outbound")
      .gte("date", since)
      .not("matched_contact_id", "is", null)
      .order("matched_contact_id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data ?? [];
  });

  const ids = new Set<number>();
  for (const r of sequenceRows) if (r.contact_id != null) ids.add(r.contact_id as number);
  for (const r of outboundRows) {
    if (r.matched_contact_id != null) ids.add(r.matched_contact_id as number);
  }
  return [...ids];
}
