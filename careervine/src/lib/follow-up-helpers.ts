/**
 * Shared helpers for follow-up message row construction.
 */

import { FollowUpMessageStatus } from "@/lib/constants";

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
