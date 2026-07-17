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
import { cancelFollowUpsForScheduledEmail } from "@/lib/follow-up-helpers";

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
