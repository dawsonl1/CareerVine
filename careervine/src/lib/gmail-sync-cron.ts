import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncAllContactEmails, syncThreadReplies, detectBounces } from "@/lib/gmail";
import {
  getPremiumSyncUserIds,
  getRecentlyTouchedContactIds,
  RECENT_OUTBOUND_DAYS,
} from "@/lib/data/sync-targets";

/**
 * The two SCHEDULED Gmail sweeps (CAR-234).
 *
 * Nothing read the inbox on a schedule before this: `POST /api/gmail/sync` is
 * user-authenticated and only runs when someone opens the app and presses
 * Refresh, so replies sat unrecorded and `outreach_stage` stayed at `contacted`
 * for people who had already written back.
 *
 * Follow-up CANCELLATION never depended on any of this — `send-follow-ups`
 * calls `threads.get` live and never reads `email_messages` — so this is a
 * freshness problem, not a correctness one. Worth stating because it bounds how
 * bad a failed sweep is: stale UI, never a follow-up sent to someone who
 * already replied.
 *
 * ── Why two cadences ─────────────────────────────────────────────────────
 *
 * Per-contact cost is one `messages.list` scoped by the `email_synced_through`
 * watermark, so a contact with nothing new costs one call and zero
 * `messages.get`. Cheap per contact, but ~1,571 contacts on a real account is
 * not cheap 72 times a day. Splitting it:
 *
 *   full   — every contact, 3x daily. Owns cold inbound from people the user
 *            never emailed, and owns bounce detection.
 *   recent — active sequences plus 9 days of outbound, every 20 minutes. A
 *            reply can only exist in a thread we started, so this has the same
 *            recall for the outreach loop at ~1/40th the population.
 *
 * The binding constraint is Vercel Hobby's 4 Active-CPU-hours/month, which
 * blocks rather than bills on overage. Google is not close to binding: the
 * combined ~7,600 calls/day is ~0.02% of the daily project quota.
 */

/** Leaves headroom inside the routes' `maxDuration = 60`. */
const SWEEP_BUDGET_MS = 50_000;
/** Per `syncAllContactEmails` call, so one slow user cannot eat the whole run. */
const PER_USER_BUDGET_MS = 20_000;

export interface SyncSweepResult {
  users: number;
  usersCompleted: number;
  usersSkipped: number;
  totalSynced: number;
  repliesIngested: number;
  failures: Array<{ userId: string; error: string }>;
  /** Users the budget never reached. Reported rather than silently dropped. */
  usersNotReached: string[];
}

function remaining(startedAt: number) {
  return SWEEP_BUDGET_MS - (Date.now() - startedAt);
}

/**
 * Every contact, for every eligible user. Also the only place `detectBounces`
 * runs on a schedule: it reads delivery-failure notices, which never match a
 * contact by address and so cannot be found by a contact-scoped pass.
 */
export async function runFullSyncSweep(service: SupabaseClient): Promise<SyncSweepResult> {
  const startedAt = Date.now();
  const userIds = await getPremiumSyncUserIds(service);
  const result: SyncSweepResult = {
    users: userIds.length,
    usersCompleted: 0,
    usersSkipped: 0,
    totalSynced: 0,
    repliesIngested: 0,
    failures: [],
    usersNotReached: [],
  };

  for (const [idx, userId] of userIds.entries()) {
    if (remaining(startedAt) <= 0) {
      result.usersNotReached = userIds.slice(idx);
      break;
    }

    try {
      let cursor: number | undefined;
      let completed = false;
      // Page until this user's contacts are exhausted or the sweep's budget
      // is. A user cut short keeps their cursor only for this invocation; the
      // next run restarts them, which is fine at 3x daily and avoids carrying
      // cross-invocation state for a job that is not latency-sensitive.
      while (remaining(startedAt) > 0) {
        const pass = await syncAllContactEmails(userId, 90, {
          cursor,
          budgetMs: Math.min(PER_USER_BUDGET_MS, remaining(startedAt)),
        });
        result.totalSynced += pass.totalSynced;
        if (pass.nextCursor === null || pass.nextCursor === undefined) {
          completed = true;
          break;
        }
        cursor = pass.nextCursor;
      }

      if (completed) {
        result.usersCompleted++;
        // Both only make sense on a completed pass: the per-contact query is
        // scoped to known addresses and cannot see a reply from an unknown one
        // or a delivery failure, so they sweep separately at the end.
        const replies = await syncThreadReplies(userId);
        result.repliesIngested += replies.ingested;
        await detectBounces(userId);
      }
    } catch (err) {
      result.failures.push({ userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * Only contacts on a live sequence or written to inside
 * `RECENT_OUTBOUND_DAYS`. Runs every 20 minutes.
 *
 * No `detectBounces` here: it is not contact-scoped, so running it 72 times a
 * day would cost the same as running it 3 times while catching nothing extra.
 * The full sweep owns it.
 */
export async function runRecentSyncSweep(service: SupabaseClient): Promise<SyncSweepResult> {
  const startedAt = Date.now();
  const userIds = await getPremiumSyncUserIds(service);
  const result: SyncSweepResult = {
    users: userIds.length,
    usersCompleted: 0,
    usersSkipped: 0,
    totalSynced: 0,
    repliesIngested: 0,
    failures: [],
    usersNotReached: [],
  };

  for (const [idx, userId] of userIds.entries()) {
    if (remaining(startedAt) <= 0) {
      result.usersNotReached = userIds.slice(idx);
      break;
    }

    try {
      const contactIds = await getRecentlyTouchedContactIds(service, userId, RECENT_OUTBOUND_DAYS);
      // Skip rather than pass an empty array: `.in("id", [])` matches nothing,
      // so handing it down would spend a Gmail connection fetch and a pass to
      // discover there was no work.
      if (contactIds.length === 0) {
        result.usersSkipped++;
        continue;
      }

      const pass = await syncAllContactEmails(userId, 90, {
        contactIds,
        budgetMs: Math.min(PER_USER_BUDGET_MS, remaining(startedAt)),
      });
      result.totalSynced += pass.totalSynced;
      result.usersCompleted++;

      // Still needed on the narrow path: a contact replying from an address we
      // do not have on file is invisible to the per-contact query no matter how
      // the population was chosen (CAR-227).
      const replies = await syncThreadReplies(userId);
      result.repliesIngested += replies.ingested;
    } catch (err) {
      result.failures.push({ userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
