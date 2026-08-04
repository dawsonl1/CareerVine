import { NextRequest, NextResponse } from "next/server";
import type { gmail_v1 } from "@googleapis/gmail";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { recordDriverBeat, SEND_WATCHER, QSTASH_SAFETY_NET } from "@/lib/watcher-health";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getGmailClient } from "@/lib/gmail-send-core";
import { activateContactByEmail } from "@/lib/gmail";
import { buildOwnAddressSet, parseEmailAddress, isBounceSenderAddress } from "@/lib/gmail-helpers";
import { sendTrackedEmail, SendPolicyError } from "@/lib/email-send";
import {
  resolveFollowUpThreadHeaders,
  THREADING_METADATA_HEADERS,
} from "@/lib/follow-up-threading";
import { filterActiveUserIds } from "@/lib/user-status";
import { capabilitiesFor } from "@/lib/capabilities/map";
import type { Capability } from "@/lib/capabilities/types";
import {
  FollowUpMessageStatus,
  FollowUpStatus,
  SEND_STALE_CLAIM_MINUTES,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";

/**
 * POST /api/cron/send-follow-ups
 *
 * Driven by the A1 send watcher within ~15s of a step coming due, and by QStash
 * hourly as a safety net (see scripts/qstash-schedules.mjs, which is the only
 * place the cadence is declared). Processes due follow-up emails:
 * - Checks for replies in the thread (cancels if replied)
 * - Sends pending follow-ups via Gmail as replies
 * - Handles disconnected Gmail gracefully
 *
 * Records which driver drove this run but does NOT run the staleness check:
 * that lives on the scheduled-emails route alone, so a dead watcher produces
 * one alert rather than one per route (CAR-215).
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(
    req,
    async (_body, source) => {
      // Both drivers stamp, under their own row key. The watcher's stamp is the
      // one the safety net reads to decide the watcher has died; the QStash
      // stamp has no reader yet (see watcher-health.ts) and exists so that
      // "which driver last ran" is answerable at all.
      await recordDriverBeat(
        createSupabaseServiceClient(),
        source === "watcher" ? SEND_WATCHER : QSTASH_SAFETY_NET,
      );
      return withCronGuard("/api/cron/send-follow-ups", () => runJob());
    },
    // The A1 watcher cannot produce a QStash signature, and it is what makes
    // follow-ups land within ~15s of coming due rather than up to an hour late.
    { allowCronBearer: true },
  );
}

/**
 * Mark a sequence completed once nothing is left to send or review.
 *
 * A lingering awaiting_review OR expired sibling keeps it open so it can't be
 * completed out from under a still-confirmable/sendable message — completing it
 * would fail the confirm route's parent-active guard and strand that sibling
 * forever (CAR-105). 'sending' counts as open too: a live claim is about to
 * resolve one way or the other.
 */
async function completeSequenceIfResolved(
  service: ReturnType<typeof createSupabaseServiceClient>,
  seqId: number,
  now: string,
): Promise<void> {
  const { count } = await service
    .from("email_follow_up_messages")
    .select("id", { count: "exact", head: true })
    .eq("follow_up_id", seqId)
    .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES, FollowUpMessageStatus.Sending]);

  if (count === 0) {
    await service
      .from("email_follow_ups")
      .update({ status: "completed", updated_at: now })
      .eq("id", seqId)
      // CAS on `active` so a concurrent teardown is not overwritten. The
      // sweeper gave this helper a second, earlier call site, and without the
      // guard a cancel landing between the sweep read and here would be
      // rewritten to 'completed' — the mirror of the rule
      // cancelFollowUpSequenceCascade already documents for its own write.
      .eq("status", FollowUpStatus.Active);
  }
}

/**
 * Minimum wall-clock gap between two messages of the SAME sequence (CAR-220).
 *
 * Steps in a sequence are meant to be days apart. When several fall due at once
 * — watcher downtime, an account reactivating, a user re-enabling automatic
 * follow-ups — they must not go out as a burst of cold emails to one person,
 * from that user's own Gmail and against their own domain reputation.
 *
 * This used to be expressed as "one send per sequence per tick", which is the
 * same thing ONLY while a tick is 10 minutes. CAR-215 replaced the 10-minute
 * QStash schedule with a watcher polling every ~15 seconds and the guard
 * silently became a 15-second one: a rate limit denominated in ticks inverts
 * the moment the clock speeds up. 10 minutes restores exactly the spacing that
 * held before that, is long enough that neither the recipient nor a spam filter
 * sees a burst, and still drains a three-step backlog inside half an hour.
 */
const FOLLOW_UP_MIN_SPACING_MINUTES = 10;

async function runJob(): Promise<NextResponse> {
  const service = createSupabaseServiceClient();
  const now = new Date().toISOString();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  // CAR-105: a parked follow-up expires 14 days out (active-aware; the nudge cron
  // may extend this once). Stamped alongside the awaiting_review flip below.
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  // Sweep stale claims (CAR-139): a row stuck in 'sending' longer than any send
  // driver can live was orphaned by a crash, or by a mark-sent write that
  // failed. Either way the Gmail send may already have gone out, so never
  // auto-resend. Recovery splits on the parent's status, which is why this
  // reads first (PostgREST can't filter an UPDATE by a joined table's column):
  //   - active parent   -> 'failed'. Terminal, and honest about the ambiguity:
  //                        delivery is unknown, so the row is surfaced as "may
  //                        already have been sent" and offers no send button.
  //   - inactive parent -> the sequence was torn down (cancel/reply) while this
  //                        row was mid-'sending' (teardown message-cancels skip
  //                        'sending' rows), so cancel it to match its dead
  //                        parent.
  //
  // CAR-207 changed the active-parent arm from 'awaiting_review'. Refusing the
  // automatic retry was always right; parking the row in the confirm-to-send
  // state was not, because that state's whole affordance is a one-click "Send
  // now" captioned as not-yet-sent. A message the contact had already received
  // was offered back for sending, and one click delivered it twice.
  const staleCutoff = new Date(Date.now() - SEND_STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { data: staleRows, error: staleError } = await service
    .from("email_follow_up_messages")
    .select("id, follow_up_id, email_follow_ups!inner(status)")
    .eq("status", FollowUpMessageStatus.Sending)
    .lt("claimed_at", staleCutoff);
  if (staleError) throw new Error(`Stale-claim sweep read failed: ${staleError.message}`);

  const staleActiveIds: number[] = [];
  const staleDeadIds: number[] = [];
  const sweptSequenceIds = new Set<number>();
  type StaleRow = {
    id: number;
    follow_up_id: number;
    email_follow_ups: { status: string } | { status: string }[] | null;
  };
  for (const r of (staleRows ?? []) as StaleRow[]) {
    const parent = Array.isArray(r.email_follow_ups) ? r.email_follow_ups[0] : r.email_follow_ups;
    if (parent?.status === "active") {
      staleActiveIds.push(r.id);
      sweptSequenceIds.add(r.follow_up_id);
    } else {
      staleDeadIds.push(r.id);
    }
  }
  // Both writes re-assert `.eq(status, 'sending')` so a row that a concurrent
  // driver resolved between the read and here is left untouched.
  // Both writes bind their error. This PR's whole thesis is that an unchecked
  // write caused a double-send, and these two were the last unchecked ones on
  // the path: 'failed' is a value the CHECK only learned in this change, so a
  // deploy that outran its migration would 23514 here, PostgREST would return
  // it in `error` without throwing, and the row would be re-swept and
  // re-rejected every ten minutes while the log below still counted it.
  if (staleActiveIds.length > 0) {
    const { error } = await service
      .from("email_follow_up_messages")
      .update({ status: FollowUpMessageStatus.Failed, claimed_at: null })
      .in("id", staleActiveIds)
      .eq("status", FollowUpMessageStatus.Sending);
    if (error) throw new Error(`Stale-claim sweep (failed) write refused: ${error.message}`);
  }
  if (staleDeadIds.length > 0) {
    const { error } = await service
      .from("email_follow_up_messages")
      .update({ status: FollowUpMessageStatus.Cancelled, claimed_at: null })
      .in("id", staleDeadIds)
      .eq("status", FollowUpMessageStatus.Sending);
    if (error) throw new Error(`Stale-claim sweep (cancelled) write refused: ${error.message}`);
  }
  if (staleActiveIds.length > 0 || staleDeadIds.length > 0) {
    console.warn(
      `[cron] Swept stale 'sending' follow-up claim(s): ${staleActiveIds.length} failed, ${staleDeadIds.length} cancelled`,
    );
  }
  // A swept row went terminal without passing through a send driver's own
  // completion check, so a sequence whose last open step was that row would sit
  // 'active' forever with nothing left to do. The due query below only revisits
  // sequences that still have a 'pending' message, so this is the only place
  // that can close them.
  for (const seqId of sweptSequenceIds) {
    await completeSequenceIfResolved(service, seqId, now);
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
  let spaced = 0;

  // Group by follow_up_id to batch reply detection
  const bySequence = new Map<number, typeof pendingMessages>();
  for (const msg of pendingMessages) {
    const seqId = msg.follow_up_id;
    if (!bySequence.has(seqId)) bySequence.set(seqId, []);
    bySequence.get(seqId)!.push(msg);
  }

  // Which of these sequences has sent something too recently to send again
  // (see FOLLOW_UP_MIN_SPACING_MINUTES). One read answers it for the whole
  // batch. Fail loud like every other read on this path: an unreadable answer
  // cannot rule the burst out, and a silently empty one would release every due
  // step of every sequence in a single pass — the exact failure being guarded.
  const spacingCutoff = new Date(Date.now() - FOLLOW_UP_MIN_SPACING_MINUTES * 60_000).toISOString();
  const { data: recentSends, error: spacingError } = await service
    .from("email_follow_up_messages")
    .select("follow_up_id")
    .in("follow_up_id", [...bySequence.keys()])
    .eq("status", FollowUpMessageStatus.Sent)
    .gt("sent_at", spacingCutoff);
  if (spacingError) throw new Error(`Follow-up spacing read failed: ${spacingError.message}`);
  const recentlySent = new Set((recentSends ?? []).map((r) => r.follow_up_id));

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
  const gmailClients = new Map<string, gmail_v1.Gmail>();

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

    // Deliverability spacing: this sequence emailed this person within the
    // window, so nothing more goes to them on this tick. Held, not resolved —
    // the rows keep their 'pending' status, the sequence comes back on the next
    // tick, and reply detection runs again before anything is sent, so a reply
    // arriving during the wait still cancels rather than being sent over.
    // Placed after the tier branch (parking a free user's step is not a send,
    // so it must not be delayed) and before the Gmail fetch, so a held sequence
    // costs no API call on any of the ~40 watcher polls it spans.
    if (recentlySent.has(seqId)) {
      spaced += messages.length;
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

    // The due query filters `thread_id is not null`, so this never fires in
    // practice — it narrows the nullable column for threads.get below. Placed
    // after the tier/disconnect paths so neither is skipped by it.
    if (!threadId) continue;

    // Check for replies in the thread (one API call per thread)
    let hasReply = false;
    let fetchedThread: gmail_v1.Schema$Thread | undefined;
    try {
      // Message-ID rides along with From on the reply-detection fetch: the
      // send below needs the thread's RFC msg-ids for In-Reply-To/References
      // (CAR-214), and asking for the header here makes correct threading cost
      // zero extra Gmail calls.
      const thread = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From", ...THREADING_METADATA_HEADERS],
      });
      fetchedThread = thread.data;

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
          hasReply = threadMessages.some((m) => {
            const fromHeader = m.payload?.headers?.find(
              (h) => h.name?.toLowerCase() === "from"
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

    // Send at most one message per sequence per run, oldest first. This is the
    // in-run half of the spacing rule: the cross-run half above reads `sent_at`,
    // which cannot see a send this run has not written yet, so the two are not
    // redundant. Neither is sufficient alone — before CAR-220 this `break` was
    // the whole guard, and it stopped meaning "spaced apart" the moment a run
    // stopped being ten minutes from the last one.
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

      // Real RFC msg-ids off the thread we already fetched. This used to pass
      // `original_gmail_message_id` — a Gmail API id, which names no
      // Message-ID anywhere, so the contact's mail client filed every
      // follow-up as a new conversation (CAR-214). Resolves to {} rather than
      // ever reinstating that value.
      const threadHeaders = await resolveFollowUpThreadHeaders(userId, threadId, {
        thread: fetchedThread,
      });

      try {
        // Tracked path: counts against the daily cap, refuses bounced
        // addresses, caches the sent message, and logs an interaction.
        await sendTrackedEmail(userId, {
          to: parent.recipient_email,
          subject: msg.subject,
          bodyHtml: msg.body_html,
          threadId: threadId ?? undefined,
          ...threadHeaders,
        }, { isFollowUp: true });

        // Gmail has the message from here on, so the claim must never be
        // released and the row must never become sendable again. This write was
        // unchecked (CAR-207): a failure here left the row in 'sending' with
        // nothing logged, and the sweeper above then made it re-sendable. Now
        // it is checked, said out loud, and deliberately left claimed — the
        // sweeper resolves it to 'failed', the same terminal path a process
        // killed mid-send takes, and the same shape gmail.ts uses for a
        // scheduled email that delivered but could not be recorded.
        const { error: markSentError } = await service
          .from("email_follow_up_messages")
          .update({ status: FollowUpMessageStatus.Sent, sent_at: now })
          .eq("id", msg.id);
        if (markSentError) {
          console.error(
            `[cron] Follow-up ${msg.id} delivered but mark-sent failed; leaving claim for the sweeper:`,
            markSentError,
          );
        }

        sent++;
        break; // one send per sequence per tick
      } catch (err) {
        // Cap reached (429): revert to pending, retry next run — never cancel.
        // Bounce (422) / any other policy refusal past the 3-day window: give
        // up, the recipient itself is the problem and no retry can fix it.
        //
        // Only a POLICY verdict may reach the terminal 'cancelled' write, which
        // nothing resurrects (it is absent from UNRESOLVED_FOLLOW_UP_MESSAGE_
        // STATUSES, and the sequence then completes). sendTrackedEmail also
        // throws on infrastructure failures — a PostgrestError from the daily-cap
        // count, a must() throw from the recipient-provenance read, a Gmail 5xx —
        // and those say nothing about whether the follow-up should ever be sent,
        // so they always revert to pending regardless of age.
        //
        // Trade-off, stated rather than hidden: this removes the aged give-up for
        // infrastructure errors, so a row failing for a persistent non-policy
        // reason now retries every cycle indefinitely instead of being cancelled
        // after 3 days. It surfaces as a repeating console.error above rather than
        // a quiet drop, which is the correct direction: never silently cancel a
        // user's follow-up because of a transient DB blip.
        const capped = err instanceof SendPolicyError && err.status === 429;
        const policyRefusal = err instanceof SendPolicyError && !capped;
        console.error(`[cron] Failed to send follow-up ${msg.id}:`, err);
        if (policyRefusal && msg.scheduled_send_at < threeDaysAgo) {
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

    // Check if all messages in the sequence are done (nothing still open).
    await completeSequenceIfResolved(service, seqId, now);
  }

  return NextResponse.json({
    processed: pendingMessages.length,
    sent,
    cancelled,
    awaitingReview,
    // Due steps deliberately held for spacing. Non-zero is normal after a
    // backlog; permanently non-zero would mean sequences are not draining.
    spaced,
  });
}
