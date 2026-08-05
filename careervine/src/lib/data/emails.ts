/**
 * Shared email-domain persistence: scheduled emails, app-side drafts, and
 * follow-up sequences (CAR-151 collapse of the MCP db.ts fork).
 *
 * Unlike the other src/lib/data modules, every function here takes an
 * explicit client: the web email routes run on a per-request service-role
 * client (auth established by withApiHandler), and the MCP data layer
 * passes its injected service client. Nothing here touches the lazy
 * browser db() — and because the client is service-role, EVERY query
 * carries .eq("user_id", …) or user_id in its payload.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "@/lib/database.types";
import {
  FollowUpMessageStatus,
  FollowUpStatus,
  ScheduledEmailStatus,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";
import {
  cancelFollowUpsForScheduledEmail,
  clampFollowUpInstants,
  parseSendTime,
} from "@/lib/follow-up-helpers";
import { zonedDateParts } from "@/lib/timezone";
import { paginateAll } from "@/lib/data/postgrest";

type EmailClient = SupabaseClient<Database>;

export interface ScheduledEmailInput {
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  bodyHtml: string;
  scheduledSendAt: string;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  contactName?: string | null;
  matchedContactId?: number | null;
}

/** Insert a pending scheduled email. Shared by POST /api/gmail/schedule and the MCP schedule_email tool. */
export async function insertScheduledEmail(client: EmailClient, userId: string, input: ScheduledEmailInput) {
  const { data, error } = await client
    .from("scheduled_emails")
    .insert({
      user_id: userId,
      recipient_email: input.to,
      cc: input.cc || null,
      bcc: input.bcc || null,
      subject: input.subject,
      body_html: input.bodyHtml,
      thread_id: input.threadId || null,
      in_reply_to: input.inReplyTo || null,
      references_header: input.references || null,
      scheduled_send_at: input.scheduledSendAt,
      status: ScheduledEmailStatus.Pending,
      contact_name: input.contactName || null,
      matched_contact_id: input.matchedContactId ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export interface EmailDraftInput {
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  contactName?: string | null;
}

/** Insert an app-side draft (email_drafts). Shared by POST /api/gmail/drafts and the MCP free-tier draft fallback. */
export async function insertEmailDraft(client: EmailClient, userId: string, input: EmailDraftInput) {
  const { data, error } = await client
    .from("email_drafts")
    .insert({
      user_id: userId,
      recipient_email: input.to || null,
      cc: input.cc || null,
      bcc: input.bcc || null,
      subject: input.subject || null,
      body_html: input.bodyHtml || null,
      thread_id: input.threadId || null,
      in_reply_to: input.inReplyTo || null,
      references_header: input.references || null,
      contact_name: input.contactName || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export interface PendingScheduledEmailRow {
  id: number;
  recipient_email: string;
  subject: string | null;
  scheduled_send_at: string;
  status: string;
  contact_name: string | null;
  matched_contact_id: number | null;
}

/**
 * Read a scheduled email that a follow-up sequence may still be anchored to
 * (CAR-214), or null when it is not this user's.
 *
 * Callers must reject a non-pending row: a sent one already has a real thread
 * (anchor to that instead), and a cancelled or failed one will never produce
 * the thread the sequence is meant to reply into.
 */
export async function getScheduledEmailForFollowUps(
  client: EmailClient,
  userId: string,
  scheduledEmailId: number,
): Promise<PendingScheduledEmailRow | null> {
  const { data, error } = await client
    .from("scheduled_emails")
    .select("id, recipient_email, subject, scheduled_send_at, status, contact_name, matched_contact_id")
    .eq("id", scheduledEmailId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return (data as PendingScheduledEmailRow | null) ?? null;
}

/**
 * Id of the active follow-up sequence already linked to a scheduled email, or
 * null. Used to refuse a second one (CAR-214): without the check, a retried
 * create stacks sequences that all fire once the opening email sends and the
 * contact receives every nudge twice.
 */
export async function findActiveSequenceForScheduledEmail(
  client: EmailClient,
  userId: string,
  scheduledEmailId: number,
): Promise<number | null> {
  const { data, error } = await client
    .from("email_follow_ups")
    .select("id")
    .eq("user_id", userId)
    .eq("scheduled_email_id", scheduledEmailId)
    .eq("status", FollowUpStatus.Active)
    .limit(1);
  if (error) throw error;
  return (data as Array<{ id: number }> | null)?.[0]?.id ?? null;
}

export interface FollowUpSequenceParent {
  originalGmailMessageId: string | null;
  threadId: string | null;
  recipientEmail: string;
  contactName: string | null;
  originalSubject: string | null;
  originalSentAt: string;
  contactId?: number | null;
  scheduledEmailId?: number | null;
}

/**
 * Insert a follow-up sequence (parent + message rows). The rows' follow_up_id
 * is stamped here, so callers may build them with a placeholder id. If the
 * message insert fails, the parent row is rolled back so no empty sequence
 * survives (adopted from POST /api/email-follow-ups; the other creators
 * previously orphaned the parent).
 *
 * Callers own message timing + body sanitization (sanitizeStoredEmailHtml at
 * the boundary) — rows arrive ready to store.
 */
export async function insertFollowUpSequenceRows(
  client: EmailClient,
  userId: string,
  parent: FollowUpSequenceParent,
  messageRows: Array<TablesInsert<"email_follow_up_messages">>,
): Promise<number> {
  const { data: followUp, error } = await client
    .from("email_follow_ups")
    .insert({
      user_id: userId,
      original_gmail_message_id: parent.originalGmailMessageId,
      thread_id: parent.threadId,
      recipient_email: parent.recipientEmail,
      contact_name: parent.contactName,
      original_subject: parent.originalSubject,
      original_sent_at: parent.originalSentAt,
      contact_id: parent.contactId ?? null,
      scheduled_email_id: parent.scheduledEmailId ?? null,
      status: FollowUpStatus.Active,
    })
    .select("id")
    .single();
  if (error) throw error;
  const followUpId = (followUp as { id: number }).id;

  const rows = messageRows.map((r) => ({ ...r, follow_up_id: followUpId }));
  const { error: msgError } = await client.from("email_follow_up_messages").insert(rows);
  if (msgError) {
    // Roll back the orphaned parent — a sequence with no steps is invisible
    // to the UI but still matches "active" reads.
    await client.from("email_follow_ups").delete().eq("id", followUpId).eq("user_id", userId);
    throw msgError;
  }
  return followUpId;
}

/**
 * Cancel a pending/failed scheduled email and tear down any follow-up
 * sequences linked to it. Returns false when no row was in a cancellable
 * state (already sending/sent, or not this user's email).
 *
 * CAS semantics (CAR-134 / rule 17): only pending or failed rows may flip to
 * cancelled — a row a send driver has claimed ('sending') or already sent
 * must not be stomped — and success is read from the update count, never a
 * .select() read-back of the filtered column.
 */
export async function cancelScheduledEmailCascade(
  client: EmailClient,
  userId: string,
  scheduledEmailId: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error, count } = await client
    .from("scheduled_emails")
    .update({ status: ScheduledEmailStatus.Cancelled, updated_at: now }, { count: "exact" })
    .eq("id", scheduledEmailId)
    .eq("user_id", userId)
    .in("status", [ScheduledEmailStatus.Pending, ScheduledEmailStatus.Failed]);
  if (error) throw error;
  if (!count) return false;

  // Only after the cancel actually landed: a sequence whose opening email
  // will never send must not keep firing follow-ups (CAR-136).
  await cancelFollowUpsForScheduledEmail(client, userId, scheduledEmailId, now);
  return true;
}

/**
 * Cancel an active follow-up sequence and its unresolved messages. Returns
 * false when the sequence isn't this user's or isn't active (a completed or
 * already-cancelled sequence keeps its status — cancelling must not rewrite
 * history).
 *
 * Parent-first ordering is deliberate: the send cron only claims messages
 * whose parent is active, so flipping the parent first makes a mid-cascade
 * crash safe (stranded child rows are ignored, then reconciled by the cron's
 * stale-claim sweep). The message sweep skips 'sending' rows for the same
 * reason the teardown in cancelFollowUpsForScheduledEmail does.
 */
export async function cancelFollowUpSequenceCascade(
  client: EmailClient,
  userId: string,
  followUpId: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error, count } = await client
    .from("email_follow_ups")
    .update({ status: FollowUpStatus.CancelledUser, updated_at: now }, { count: "exact" })
    .eq("id", followUpId)
    .eq("user_id", userId)
    .eq("status", FollowUpStatus.Active);
  if (error) throw error;
  if (!count) return false;

  const { error: msgError } = await client
    .from("email_follow_up_messages")
    .update({ status: FollowUpMessageStatus.Cancelled })
    .eq("follow_up_id", followUpId)
    .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
  if (msgError) throw msgError;
  return true;
}

/** One step's new landing time, as `rescheduleFollowUpSequenceCascade` reports it. */
export interface RescheduledFollowUpStep {
  sequenceNumber: number;
  scheduledSendAt: string;
}

/**
 * Move the unresolved steps of an active sequence to a new time of day, keeping
 * the calendar date each one already has. Returns null when the sequence isn't
 * this user's or isn't active.
 *
 * ── Why the date comes from the ROW, not from send_after_days ────────────
 *
 * `send_after_days` deliberately stores the REQUESTED delay, not the clamped
 * one (see `buildFollowUpMessageRows`), so a step that was clamped forward at
 * creation has a stored date that `original_sent_at + send_after_days` does not
 * reproduce. Re-deriving would silently walk such a step BACKWARD onto a date
 * the user never agreed to. Reading the date off `scheduled_send_at` keeps
 * "same day, new clock" literally true.
 *
 * ── Why nothing else moves ──────────────────────────────────────────────
 *
 * Only `scheduled_send_at` is written. Bodies, subjects, sequence numbers and
 * `send_after_days` are untouched, which is the whole point of this path
 * existing next to `PUT /api/gmail/follow-ups/[id]`: that route rebuilds every
 * unresolved row from caller-supplied copy, and reviewed outbound text should
 * not be at risk for what is a metadata change.
 *
 * 'sending' rows are excluded with the rest of the resolved statuses: a step
 * mid-claim belongs to the send driver, and retiming it under that driver would
 * race the claim.
 */
export async function rescheduleFollowUpSequenceCascade(
  client: EmailClient,
  userId: string,
  followUpId: number,
  sendTime: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<RescheduledFollowUpStep[] | null> {
  // Ownership + active check in one read. The service role bypasses RLS, so
  // user_id is what makes this another user's sequence invisible rather than
  // merely unreachable.
  const { data: parent, error: parentError } = await client
    .from("email_follow_ups")
    .select("id")
    .eq("id", followUpId)
    .eq("user_id", userId)
    .eq("status", FollowUpStatus.Active)
    .maybeSingle();
  if (parentError) throw parentError;
  if (!parent) return null;

  // Ordered by sequence_number so the strictly-increasing guard inside
  // clampFollowUpInstants applies in send order rather than PostgREST's, and
  // paged because a silent 1000-row truncation here would leave the tail of a
  // sequence sitting at the old time while the head moved.
  const steps = await paginateAll(async (from, to) => {
    const { data, error } = await client
      .from("email_follow_up_messages")
      .select("id, sequence_number, scheduled_send_at")
      .eq("follow_up_id", followUpId)
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES])
      .order("sequence_number", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data;
  });
  if (steps.length === 0) return [];

  const { hour, minute } = parseSendTime(sendTime);
  const instants = clampFollowUpInstants(
    steps.map((s) => ({
      localDate: zonedDateParts(new Date(s.scheduled_send_at), timeZone),
      hour,
      minute,
    })),
    timeZone,
    now,
  );

  const updated: RescheduledFollowUpStep[] = [];
  for (const [idx, step] of steps.entries()) {
    const scheduledSendAt = instants[idx].toISOString();
    const { error: updateError } = await client
      .from("email_follow_up_messages")
      .update({ scheduled_send_at: scheduledSendAt })
      .eq("id", step.id)
      // Re-assert the status at write time: the send driver may have claimed
      // this row into 'sending' between the read above and here, and a retime
      // landing on a claimed row would move a send that is already in flight.
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
    if (updateError) throw updateError;
    updated.push({ sequenceNumber: step.sequence_number, scheduledSendAt });
  }
  return updated;
}
