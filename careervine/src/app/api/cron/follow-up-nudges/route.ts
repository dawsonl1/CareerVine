import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendAppEmail } from "@/lib/notify/email";
import { signUnsubscribeToken } from "@/lib/notify/tokens";
import { trackServer } from "@/lib/analytics/server";
import { renderNudgeDigest, type NudgeItem } from "./digest";
import { must } from "@/lib/data/client";

export const maxDuration = 60;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const WINDOW = 14 * DAY;

/**
 * POST /api/cron/follow-up-nudges
 * Called by QStash once daily (CAR-105). For every free-tier follow-up parked
 * `awaiting_review`, this cron runs two independent state machines:
 *
 *  1. Cadence (reminder emails): elapsed-day milestones from parked_at — day 0
 *     (parked), day 4, day 9. Eligibility is derived from ABSOLUTE elapsed days
 *     (target_stage), not a bare counter, so a missed run skips the milestone
 *     instead of back-sending a stale day-0. Each due message is claimed
 *     atomically BEFORE the email goes out (idempotent against QStash's
 *     at-least-once retries), then all of a user's claimed items collapse into
 *     ONE digest email that run.
 *
 *  2. Expiry (active-aware): an item expires at parked_at+14d only if the user
 *     was active in-app during the window; otherwise it waits for their return
 *     and expires 24h after (set-once), and if they never return it never
 *     expires. Expiry is a soft retire, not a delete: the message flips to
 *     `expired` (still visible + one-click sendable) and the parent sequence
 *     stays `active`.
 *
 * Emails are sent BEFORE the expiry flip so a same-run day-9 is never eaten.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () =>
    withCronGuard("/api/cron/follow-up-nudges", () => runJob()),
  );
}

interface ParkedMessage {
  id: number;
  follow_up_id: number;
  subject: string | null;
  parked_at: string | null;
  expires_at: string | null;
  reminder_count: number;
  seen_during_window: boolean;
  email_follow_ups: {
    user_id: string;
    contact_name: string | null;
    recipient_email: string | null;
    status: string;
  };
}

interface UserRow {
  id: string;
  status: string | null;
  web_last_seen_at: string | null;
  followup_nudges_enabled: boolean | null;
}

async function runJob(): Promise<NextResponse> {
  const service = createSupabaseServiceClient();
  const nowMs = Date.now();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://www.careervine.app").replace(/\/$/, "");

  // All parked, still-active follow-up messages. awaiting_review is naturally a
  // small set (free-tier items pending confirmation); a generous cap bounds
  // maxDuration. Ordered oldest-parked-first so the cap is FIFO: overflow rows
  // are the newest, and processed items leave the set as they expire/confirm, so
  // a >1000 backlog drains deterministically instead of starving a stable tail.
  const rows = must(
    await service
      .from("email_follow_up_messages")
      .select(`
        id, follow_up_id, subject, parked_at, expires_at, reminder_count, seen_during_window,
        email_follow_ups!inner(user_id, contact_name, recipient_email, status)
      `)
      .eq("status", "awaiting_review")
      .eq("email_follow_ups.status", "active")
      .order("parked_at", { ascending: true })
      .limit(1000),
  );

  const messages = (rows ?? []) as unknown as ParkedMessage[];
  if (messages.length === 0) {
    return NextResponse.json({ processed: 0, nudged: 0, expired: 0 });
  }

  // Batch-fetch each involved user's status + activity/opt-out in one round-trip.
  const userIds = [...new Set(messages.map((m) => m.email_follow_ups.user_id))];
  const { data: userRows, error: userErr } = await service
    .from("users")
    .select("id, status, web_last_seen_at, followup_nudges_enabled")
    .in("id", userIds);
  if (userErr) {
    console.error("[cron:follow-up-nudges] user fetch failed:", userErr.message);
    return NextResponse.json({ processed: 0, error: "users_fetch" });
  }
  const userById = new Map<string, UserRow>(
    ((userRows ?? []) as UserRow[]).map((u) => [u.id, u]),
  );

  const analyticsJobs: Promise<unknown>[] = [];

  // Preflight the two secrets the email phase needs: RESEND_API_KEY to send, and
  // NUDGE_UNSUBSCRIBE_SECRET to mint a working one-click unsubscribe link (a
  // reminder email without a valid unsubscribe is not CAN-SPAM safe, and an empty
  // signing key would produce forgeable links). Missing either => skip claiming
  // AND sending this run so we never advance reminder_count while no email goes
  // out (the item simply nudges next run once configured). Expiry (Phase 3) still
  // runs regardless. In a correct deploy the QStash schedule is created only after
  // both secrets are set, so this guard is defense-in-depth.
  const canEmail = !!process.env.RESEND_API_KEY && !!process.env.NUDGE_UNSUBSCRIBE_SECRET;
  if (!canEmail) {
    console.error(
      "[cron:follow-up-nudges] RESEND_API_KEY or NUDGE_UNSUBSCRIBE_SECRET missing; skipping nudge emails this run",
    );
  }

  // ── Phase 1: cadence — claim due milestones (before sending) ─────────────
  // digestByUser[userId] = the items claimed for this run's digest. Iterates the
  // empty set when we can't email, so nothing is claimed and Phase 2 is a no-op.
  const digestByUser = new Map<string, NudgeItem[]>();

  for (const msg of canEmail ? messages : []) {
    const parent = msg.email_follow_ups;
    const user = userById.get(parent.user_id);
    // Suspended/missing accounts are frozen: hold everything (no nudge, no
    // expiry) so it resumes untouched if the account reactivates.
    if (!user || user.status !== "active") continue;
    if (user.followup_nudges_enabled === false) continue;
    if (!msg.parked_at) continue;

    const parkedMs = Date.parse(msg.parked_at);
    if (Number.isNaN(parkedMs)) continue;
    // No emails at or after the 14-day window edge.
    if (nowMs >= parkedMs + WINDOW) continue;

    // Milestone the elapsed time entitles this item to (day 0/4/9 -> 1/2/3).
    const target =
      nowMs >= parkedMs + 9 * DAY ? 3 : nowMs >= parkedMs + 4 * DAY ? 2 : nowMs >= parkedMs ? 1 : 0;
    if (msg.reminder_count >= target) continue;

    // Atomic claim-before-send: bump to `target` only if still under it. Uses
    // count (never .select()) because the update mutates the same column the
    // filter tests — a returning-representation read would re-apply `< target`
    // to the new value and read empty (rule 17). count === 1 == we won the row.
    const { count } = await service
      .from("email_follow_up_messages")
      .update(
        { reminder_count: target, last_reminder_at: new Date(nowMs).toISOString() },
        { count: "exact" },
      )
      .eq("id", msg.id)
      .eq("status", "awaiting_review")
      .lt("reminder_count", target);

    if (count && count > 0) {
      msg.reminder_count = target; // keep in-memory view consistent
      const bucket = digestByUser.get(parent.user_id) ?? [];
      bucket.push({
        contactName: parent.contact_name || parent.recipient_email || "your contact",
        subject: msg.subject || "(no subject)",
      });
      digestByUser.set(parent.user_id, bucket);
    }
  }

  // ── Phase 2: send one digest per user ────────────────────────────────────
  const today = new Date(nowMs).toISOString().slice(0, 10);
  let nudged = 0;
  for (const [uid, items] of digestByUser) {
    // GoTrue response, so must() (typed for PostgREST) does not fit: bind and
    // check by hand. A lookup failure must be logged rather than read as
    // "user has no email", but it also must not abandon the other users'
    // digests, so this leg skips loudly instead of throwing.
    const { data: authData, error: authError } = await service.auth.admin.getUserById(uid);
    if (authError) {
      console.error(`[cron follow-up-nudges] auth lookup failed for user ${uid}:`, authError);
      continue;
    }
    const to = authData?.user?.email;
    if (!to) continue;

    const unsubscribeUrl = `${appUrl}/api/notifications/unsubscribe?token=${signUnsubscribeToken(uid, "followup_nudges")}`;
    const { subject, html, text } = renderNudgeDigest(items, appUrl, unsubscribeUrl);
    const res = await sendAppEmail({
      to,
      subject,
      html,
      text,
      listUnsubscribeUrl: unsubscribeUrl,
      // Delivery is best-effort, at-most-once per milestone: the atomic claim above
      // already bumped reminder_count, and a failed send is NOT reverted, so this
      // milestone won't retry. That is deliberate — the alternative (revert on
      // failure) would re-send next day under a different date-scoped key and could
      // double-send a message Resend actually delivered behind a 5xx. A dropped
      // early milestone self-heals: day 4/9 re-send the same stage-agnostic digest.
      // The key is same-day dedupe insurance in case this exact send is retried.
      idempotencyKey: `nudge-${uid}-${today}`,
    });
    if (res.ok) {
      nudged++;
      analyticsJobs.push(trackServer(uid, "nudge_sent", { items: items.length }));
    } else {
      console.error(`[cron:follow-up-nudges] digest send failed for ${uid}: ${res.error}`);
    }
  }

  // ── Phase 3: active-aware expiry ─────────────────────────────────────────
  let expired = 0;
  for (const msg of messages) {
    const parent = msg.email_follow_ups;
    const user = userById.get(parent.user_id);
    if (!user || user.status !== "active") continue;
    if (!msg.parked_at) continue;

    const parkedMs = Date.parse(msg.parked_at);
    if (Number.isNaN(parkedMs)) continue;
    const windowEndMs = parkedMs + WINDOW;
    const webSeenMs = user.web_last_seen_at ? Date.parse(user.web_last_seen_at) : null;
    let seen = msg.seen_during_window === true;

    // (a) Engagement: active in-app at or after parking, observed within the
    // window, marks the item so it expires cleanly at the window edge. Daily
    // sampling means a late first-sighting can miss it — that only DELAYS
    // expiry (falls to the grace branch), which is the safe direction.
    if (!seen && nowMs <= windowEndMs && webSeenMs !== null && webSeenMs >= parkedMs) {
      await service
        .from("email_follow_up_messages")
        .update({ seen_during_window: true })
        .eq("id", msg.id)
        .eq("status", "awaiting_review");
      seen = true;
    }

    // (b) Decide the effective deadline (ms), or null = do not expire yet.
    let expireAtMs: number | null = null;
    if (seen) {
      expireAtMs = windowEndMs;
    } else if (nowMs >= windowEndMs) {
      const storedMs = msg.expires_at ? Date.parse(msg.expires_at) : windowEndMs;
      const graceGranted = storedMs > windowEndMs + HOUR; // grace pushes it >= +24h
      if (graceGranted) {
        expireAtMs = storedMs;
      } else if (webSeenMs !== null && webSeenMs > windowEndMs) {
        // They came back after the window: expire 24h after the return, set ONCE.
        // The .lte guard makes the write idempotent so a daily-returning user's
        // advancing last-seen can't keep pushing the deadline out forever.
        const graceMs = webSeenMs + DAY;
        await service
          .from("email_follow_up_messages")
          .update({ expires_at: new Date(graceMs).toISOString() })
          .eq("id", msg.id)
          .eq("status", "awaiting_review")
          .lte("expires_at", new Date(windowEndMs + HOUR).toISOString());
        expireAtMs = graceMs;
      }
      // else: still away — leave awaiting_review (never-return edge: never expires).
    }

    // (c) Flip. count (not .select()) again — status is both filtered and set.
    if (expireAtMs !== null && nowMs >= expireAtMs) {
      const { count } = await service
        .from("email_follow_up_messages")
        .update({ status: "expired" }, { count: "exact" })
        .eq("id", msg.id)
        .eq("status", "awaiting_review");
      if (count && count > 0) {
        expired++;
        analyticsJobs.push(trackServer(parent.user_id, "follow_up_expired", {}));
      }
    }
  }

  // Await analytics so the serverless freeze doesn't cut off the PostHog flush.
  await Promise.allSettled(analyticsJobs);

  return NextResponse.json({ processed: messages.length, nudged, expired });
}
