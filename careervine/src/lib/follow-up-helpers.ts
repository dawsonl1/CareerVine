/**
 * Shared helpers for follow-up message row construction and teardown.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FollowUpStatus,
  FollowUpMessageStatus,
  UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES,
} from "@/lib/constants";

/**
 * Cancel every active follow-up sequence linked to a scheduled email
 * (email_follow_ups.scheduled_email_id) plus their unresolved messages.
 * Runs after the scheduled email itself was cancelled: a sequence whose
 * opening email will never send must not keep firing follow-ups into a
 * thread that doesn't exist. Shared by the web DELETE route and the MCP
 * cancel_scheduled tool (CAR-136).
 */
export async function cancelFollowUpsForScheduledEmail(
  service: SupabaseClient,
  userId: string,
  scheduledEmailId: number,
  now: string = new Date().toISOString(),
): Promise<void> {
  // user_id scoping is defense-in-depth (CAR-151): the caller verified the
  // scheduled email's ownership, but this runs on the service client, so the
  // linkage read must not trust scheduled_email_id alone.
  const { data: linked, error: readError } = await service
    .from("email_follow_ups")
    .select("id")
    .eq("scheduled_email_id", scheduledEmailId)
    .eq("user_id", userId)
    .eq("status", FollowUpStatus.Active);
  if (readError) throw readError;
  if (!linked || linked.length === 0) return;

  const fuIds = linked.map((fu: { id: number }) => fu.id);
  const { error: msgError } = await service
    .from("email_follow_up_messages")
    .update({ status: FollowUpMessageStatus.Cancelled })
    .in("follow_up_id", fuIds)
    // Include expired so a still-sendable expired sibling isn't orphaned when
    // its parent scheduled email is cancelled (CAR-105).
    .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);
  if (msgError) throw msgError;

  const { error: fuError } = await service
    .from("email_follow_ups")
    .update({ status: FollowUpStatus.CancelledUser, updated_at: now })
    .in("id", fuIds)
    .eq("user_id", userId);
  if (fuError) throw fuError;
}

interface FollowUpMessageInput {
  sendAfterDays: number;
  subject: string;
  bodyHtml: string;
  sendTime?: string;
}

/**
 * Build database rows for follow-up messages.
 *
 * @param followUpId - The parent follow-up sequence ID
 * @param messages - Array of message inputs from the client
 * @param sentAt - The original email's sent date (used to compute scheduled dates)
 * @param sequenceOffset - Starting sequence number (use to avoid collisions with already-sent messages)
 */
export function buildFollowUpMessageRows(
  followUpId: number,
  messages: FollowUpMessageInput[],
  sentAt: Date,
  sequenceOffset: number = 0,
) {
  return messages.map((m, idx) => {
    const scheduledDate = new Date(sentAt);
    scheduledDate.setDate(scheduledDate.getDate() + m.sendAfterDays);
    if (m.sendTime) {
      const [h, min] = m.sendTime.split(":").map(Number);
      scheduledDate.setUTCHours(h, min, 0, 0);
    } else {
      scheduledDate.setUTCHours(9, 0, 0, 0);
    }
    return {
      follow_up_id: followUpId,
      sequence_number: sequenceOffset + idx + 1,
      send_after_days: m.sendAfterDays,
      subject: m.subject,
      body_html: m.bodyHtml,
      status: FollowUpMessageStatus.Pending,
      scheduled_send_at: scheduledDate.toISOString(),
    };
  });
}

/** Prior open-step snapshot used when rebuilding a sequence on edit (CAR-125). */
export type PriorFollowUpMessageSnapshot = {
  sequence_number: number;
  send_after_days: number;
  status: string;
  parked_at: string | null;
  expires_at: string | null;
  reminder_count: number | null;
  last_reminder_at: string | null;
  seen_during_window: boolean | null;
};

type RebuildRow = {
  sequence_number: number;
  send_after_days: number;
  status: string;
  scheduled_send_at: string;
  subject: string;
  body_html: string;
  follow_up_id: number;
};

/**
 * After a follow-up edit rebuild, restore awaiting_review/expired + park metadata
 * when the step's delay is unchanged so "Send now" still works immediately.
 * A delay change is treated as an intentional reschedule → stays pending.
 */
export function reconcileFollowUpEditStatuses<T extends RebuildRow>(
  newRows: T[],
  priorBySequence: Map<number, PriorFollowUpMessageSnapshot>,
): Array<
  T & {
    parked_at?: string | null;
    expires_at?: string | null;
    reminder_count?: number;
    last_reminder_at?: string | null;
    seen_during_window?: boolean;
  }
> {
  return newRows.map((row) => {
    const prior = priorBySequence.get(row.sequence_number);
    if (
      prior &&
      (prior.status === FollowUpMessageStatus.AwaitingReview ||
        prior.status === FollowUpMessageStatus.Expired) &&
      prior.send_after_days === row.send_after_days
    ) {
      return {
        ...row,
        status: prior.status,
        parked_at: prior.parked_at,
        expires_at: prior.expires_at,
        reminder_count: prior.reminder_count ?? 0,
        last_reminder_at: prior.last_reminder_at,
        seen_during_window: prior.seen_during_window ?? false,
      };
    }
    return row;
  });
}
