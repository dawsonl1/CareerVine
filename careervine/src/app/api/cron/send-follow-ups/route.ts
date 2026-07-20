import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getGmailClient } from "@/lib/gmail-send-core";
import { activateContactByEmail } from "@/lib/gmail";
import { buildOwnAddressSet, parseEmailAddress, isBounceSenderAddress } from "@/lib/gmail-helpers";
import { sendTrackedEmail, SendPolicyError } from "@/lib/email-send";
import { filterActiveUserIds } from "@/lib/user-status";
import { capabilitiesFor } from "@/lib/capabilities/map";
import type { Capability } from "@/lib/capabilities/types";
import {
  FollowUpMessageStatus,
  SEND_STALE_CLAIM_MINUTES,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";

/**
 * POST /api/cron/send-follow-ups
 * Called by QStash every 10 minutes (see scripts/qstash-schedules.mjs, which is
 * the only place the cadence is declared). Processes due follow-up emails:
 * - Checks for replies in the thread (cancels if replied)
 * - Sends pending follow-ups via Gmail as replies
 * - Handles disconnected Gmail gracefully
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () =>
    withCronGuard("/api/cron/send-follow-ups", () => runJob()),
  );
}

async function runJob(): Promise<NextResponse> {
  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  // CAR-105: a parked follow-up expires 14 days out (active-aware; the nudge cron
  // may extend this once). Stamped alongside the awaiting_review flip below.
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  // Sweep stale claims (CAR-139): a row stuck in 'sending' longer than any send
  // driver can live was orphaned by a crash. The crash may have happened after
  // the Gmail send but before the mark-sent write, so never auto-resend (an
  // automatic retry could double-send a real email). Recovery splits on the
  // parent's status, which is why this reads first (PostgREST can't filter an
  // UPDATE by a joined table's column):
  //   - active parent   -> park 'awaiting_review' with the full CAR-105 stamp,
  //                        so the portal, contact page, and nudge emails surface
  //                        it for the user to resolve.
  //   - inactive parent -> the sequence was torn down (cancel/reply) while this
  //                        row was mid-'sending' (teardown message-cancels skip
  //                        'sending' rows), so cancel it to match its dead
  //                        parent. Parking it would strand it behind the
  //                        parent-active-gated surfaces as an invisible orphan.
  const staleCutoff = new Date(Date.now() - SEND_STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { data: staleRows, error: staleError } = await service
    .from("email_follow_up_messages")
    .select("id, email_follow_ups!inner(status)")
    .eq("status", FollowUpMessageStatus.Sending)
    .lt("claimed_at", staleCutoff);
  if (staleError) throw new Error(`Stale-claim sweep read failed: ${staleError.message}`);

  const staleActiveIds: number[] = [];
  const staleDeadIds: number[] = [];
  type StaleRow = { id: number; email_follow_ups: { status: string } | { status: string }[] | null };
  for (const r of (staleRows ?? []) as StaleRow[]) {
    const parent = Array.isArray(r.email_follow_ups) ? r.email_follow_ups[0] : r.email_follow_ups;
    (parent?.status === "active" ? staleActiveIds : staleDeadIds).push(r.id);
  }
  // Both writes re-assert `.eq(status, 'sending')` so a row that a concurrent
  // driver resolved between the read and here is left untouched.
  if (staleActiveIds.length > 0) {
    await service
      .from("email_follow_up_messages")
      .update({
        status: FollowUpMessageStatus.AwaitingReview,
        parked_at: now,
        expires_at: expiresAt,
        reminder_count: 0,
        last_reminder_at: null,
        seen_during_window: false,
        claimed_at: null,
      })
      .in("id", staleActiveIds)
      .eq("status", FollowUpMessageStatus.Sending);
  }
  if (staleDeadIds.length > 0) {
    await service
      .from("email_follow_up_messages")
      .update({ status: FollowUpMessageStatus.Cancelled, claimed_at: null })
      .in("id", staleDeadIds)
      .eq("status", FollowUpMessageStatus.Sending);
  }
  if (staleActiveIds.length > 0 || staleDeadIds.length > 0) {
    console.warn(
      `[cron] Swept stale 'sending' follow-up claim(s): ${staleActiveIds.length} parked, ${staleDeadIds.length} cancelled`,
    );
  }

  // Query pending follow-up messages that are due. Fail loud (F6): a read
  // error must surface as a cron failure via withCronGuard, not a healthy
  // {processed: 0} that hides missed sends from alerting.
  const { data: pendingMessages, error: dueError } = await service
    .from("email_follow_up_messages")
    .select(`
      id, follow_up_id, subject, body_html, scheduled_send_at,
      email_follow_ups!inner(
        id, user_id, thread_id, recipient_email, contact_name,
        original_gmail_message_id, original_subject, status
      )
    `)
    .eq("status", "pending")
    .lte("scheduled_send_at", now)
    .not("email_follow_ups.thread_id", "is", null)
    .eq("email_follow_ups.status", "active")
    .order("scheduled_send_at", { ascending: true })
    .limit(20);
  if (dueError) throw new Error(`Due follow-up query failed: ${dueError.message}`);

  if (!pendingMessages || pendingMessages.length === 0) {
    return NextResponse.json({ processed: 0, sent: 0, cancelled: 0 });
  }

  let sent = 0;
  let cancelled = 0;
  let awaitingReview = 0;

  // Group by follow_up_id to batch reply detection
  const bySequence = new Map<number, typeof pendingMessages>();
  for (const msg of pendingMessages) {
    const seqId = msg.follow_up_id;
    if (!bySequence.has(seqId)) bySequence.set(seqId, []);
    bySequence.get(seqId)!.push(msg);
  }

  // Pre-fetch gmail_connections for all users to avoid N+1
  const userIds = [...new Set([...bySequence.values()].map((msgs) => msgs[0].email_follow_ups.user_id))];
  // Suspended accounts are frozen: their follow-ups stay pending (held, not
  // dropped) and resume if the account is reactivated.
  const activeUserIds = await filterActiveUserIds(service, userIds);
  // Fail loud on a read error (matches the sweep/due reads above): a silently
  // null result here would empty ownAddressesByUser AND capsByUser for every
  // user, and an empty own-address set makes the user's own messages read as
  // contact replies — mass false cancels + false activations.
  const { data: connections, error: connectionsError } = await service
    .from("gmail_connections")
    .select("user_id, gmail_address, send_as_aliases, modify_scope_granted, automatic_features_enabled, premium_enabled")
    .in("user_id", [...activeUserIds]);
  if (connectionsError) {
    throw new Error(`Gmail connections prefetch failed: ${connectionsError.message}`);
  }
  // Own-address set per user (CAR-153/R2.5): primary + send-as aliases,
  // lowercased — a user replying manually from an alias must not read as the
  // contact replying.
  const ownAddressesByUser = new Map(
    (connections || []).map((c): [string, Set<string>] => [
      c.user_id,
      buildOwnAddressSet(c.gmail_address, c.send_as_aliases),
    ]),
  );
  // Resolve each connected user's capabilities from the SAME pre-fetch (no extra
  // round-trips). followups:auto gates auto-send; a connected user without it is
  // on the free (or opted-out) tier and gets confirm-to-send instead.
  const capsByUser = new Map<string, Set<Capability>>(
    (connections || []).map((c): [string, Set<Capability>] => [
      c.user_id,
      capabilitiesFor({
        modifyScopeGranted: c.modify_scope_granted ?? false,
        automaticFeaturesEnabled: c.automatic_features_enabled ?? false,
        premiumEnabled: c.premium_enabled ?? true,
        hasConnection: true,
      }),
    ]),
  );

  // Cache Gmail clients per user to avoid redundant auth
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
  const gmailClients = new Map<string, any>();

  for (const [seqId, messages] of bySequence) {
    const parent = messages[0].email_follow_ups;
    const userId = parent.user_id;
    const threadId = parent.thread_id;

    if (!activeUserIds.has(userId)) continue;

    // No auto-send tier: a CONNECTED user without followups:auto does not
    // auto-send, and skips Gmail entirely. This MUST run before the Gmail fetch
    // below: a free user's gmail.send token authenticates fine, but the
    // reply-detection threads.get needs a read scope they lack and would 403,
    // silently skipping their follow-ups forever. `caps` is defined only for
    // users WITH a connection row, so a disconnected user (no caps) falls through
    // to the 3-day-cancel path below instead of being handled here.
    //
    // Two sub-cases split on tier:
    //  - Free (outreach:portal): park due messages as 'awaiting_review' for the
    //    user to confirm from the Outreach portal (confirm-to-send).
    //  - Premium who opted out of automation (no outreach:portal): hold — leave
    //    the messages pending until they re-enable automatic follow-ups. Parking
    //    them as awaiting_review would strand them behind a portal a premium user
    //    never sees.
    const caps = capsByUser.get(userId);
    if (caps && !caps.has("followups:auto")) {
      if (caps.has("outreach:portal")) {
        // CAR-105: stamp the expiry/nudge anchors as we park. parked_at = P (the
        // countdown/expiry/cadence origin); reminder_count/seen_during_window reset
        // so the nudge cron starts this item's day-0/4/9 sequence cleanly.
        await service
          .from("email_follow_up_messages")
          .update({
            status: "awaiting_review",
            parked_at: now,
            expires_at: expiresAt,
            reminder_count: 0,
            last_reminder_at: null,
            seen_during_window: false,
          })
          .in("id", messages.map((m) => m.id))
          .eq("status", "pending");
        awaitingReview += messages.length;
      }
      continue;
    }

    // Check if Gmail is accessible for this user (cached)
    let gmail = gmailClients.get(userId);
    if (!gmail) {
      try {
        gmail = await getGmailClient(userId);
        gmailClients.set(userId, gmail);
      } catch {
        // Gmail disconnected — check if messages are stale (3+ days past due)
        const oldestMsg = messages[0];
        if (oldestMsg.scheduled_send_at < threeDaysAgo) {
          await service
            .from("email_follow_ups")
            .update({ status: "cancelled_user", updated_at: now })
            .eq("id", seqId);
          await service
            .from("email_follow_up_messages")
            .update({ status: "cancelled" })
            .eq("follow_up_id", seqId)
            .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
          cancelled += messages.length;
        }
        continue;
      }
    }

    // Check for replies in the thread (one API call per thread)
    let hasReply = false;
    try {
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From"],
      });

      const threadMessages = thread.data.messages || [];
      // If there are more messages than just the original, check if any are
      // from someone else. Membership in the own-address set (primary +
      // send-as aliases, CAR-153/R2.5) replaces the old substring test, which
      // misread alias-sent mail as a contact reply. (The old test's empty-
      // address degenerate case went the other way: "x".includes("") is true,
      // so an empty stored address made every message read as the user's own
      // and NOTHING was ever flagged.)
      if (threadMessages.length > 1) {
        const ownAddresses = ownAddressesByUser.get(userId) ?? new Set<string>();

        // Empty set = ownership cannot be determined (user missing from the
        // prefetch, e.g. a mid-run connect race). Inverting to "everything is
        // a reply" would terminally cancel the sequence and falsely activate
        // the contact — stay conservative and treat it as no reply, matching
        // the old code's degenerate behavior.
        if (ownAddresses.size > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
          hasReply = threadMessages.some((m: any) => {
            const fromHeader = m.payload?.headers?.find(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
              (h: any) => h.name?.toLowerCase() === "from"
            );
            const fromAddr = parseEmailAddress(fromHeader?.value || "");
            // NDRs are delivery failures, not replies — detectBounces owns
            // them (cancelled_bounce), and cancelling as "replied" here would
            // also activate the very contact whose address just bounced.
            return Boolean(fromAddr) && !ownAddresses.has(fromAddr) && !isBounceSenderAddress(fromAddr);
          });
        }
      }
    } catch {
      // If thread check fails, skip this cycle (don't send, don't cancel)
      continue;
    }

    if (hasReply) {
      // Cancel the entire sequence — they replied!
      await service
        .from("email_follow_ups")
        .update({ status: "cancelled_reply", updated_at: now })
        .eq("id", seqId);
      await service
        .from("email_follow_up_messages")
        .update({ status: "cancelled" })
        .eq("follow_up_id", seqId)
        .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
      // Their reply graduates prospects/bench into the active network
      await activateContactByEmail(userId, parent.recipient_email);
      cancelled += messages.length;
      continue;
    }

    // Send at most one message per sequence per tick, oldest first. Steps in
    // a sequence are meant to be spaced days apart; sending every due step in
    // one run would burst multiple cold emails seconds apart (deliverability
    // risk) if several fell due together (e.g. after cron downtime).
    for (const msg of messages) {
      // Atomic status check: set to 'sending' to prevent duplicates. Detect the
      // claim via count, not a .select() read-back — the update sets the same
      // `status` the filter tests, and the house CAS convention (rule 17,
      // CAR-108) is count-based so success never depends on representation or
      // RLS visibility semantics.
      const { count: claimedCount } = await service
        .from("email_follow_up_messages")
        .update(
          { status: FollowUpMessageStatus.Sending, claimed_at: now },
          { count: "exact" },
        )
        .eq("id", msg.id)
        .eq("status", "pending");

      if (claimedCount !== 1) continue; // Already being processed

      try {
        // Tracked path: counts against the daily cap, refuses bounced
        // addresses, caches the sent message, and logs an interaction.
        await sendTrackedEmail(userId, {
          to: parent.recipient_email,
          subject: msg.subject,
          bodyHtml: msg.body_html,
          threadId: threadId ?? undefined,
          inReplyTo: parent.original_gmail_message_id ?? undefined,
          references: parent.original_gmail_message_id ?? undefined,
        }, { isFollowUp: true });

        await service
          .from("email_follow_up_messages")
          .update({ status: "sent", sent_at: now })
          .eq("id", msg.id);

        sent++;
        break; // one send per sequence per tick
      } catch (err) {
        // Cap reached (429): revert to pending, retry next run — never cancel.
        // Bounce (422) / other errors past the 3-day window: give up.
        const capped = err instanceof SendPolicyError && err.status === 429;
        console.error(`[cron] Failed to send follow-up ${msg.id}:`, err);
        if (!capped && msg.scheduled_send_at < threeDaysAgo) {
          await service
            .from("email_follow_up_messages")
            .update({ status: "cancelled", claimed_at: null })
            .eq("id", msg.id);
        } else {
          // Revert to pending so it's retried next cycle
          await service
            .from("email_follow_up_messages")
            .update({ status: "pending", claimed_at: null })
            .eq("id", msg.id);
        }
        if (capped) break; // cap is global — stop this run
      }
    }

    // Check if all messages in the sequence are done (nothing still open). A
    // lingering awaiting_review OR expired sibling keeps the sequence open so it
    // can't be marked completed out from under a still-confirmable/sendable
    // message — completing it would fail the confirm route's parent-active guard
    // and strand that sibling forever (CAR-105).
    const { count } = await service
      .from("email_follow_up_messages")
      .select("id", { count: "exact", head: true })
      .eq("follow_up_id", seqId)
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES, FollowUpMessageStatus.Sending]);

    if (count === 0) {
      await service
        .from("email_follow_ups")
        .update({ status: "completed", updated_at: now })
        .eq("id", seqId);
    }
  }

  return NextResponse.json({
    processed: pendingMessages.length,
    sent,
    cancelled,
    awaitingReview,
  });
}
