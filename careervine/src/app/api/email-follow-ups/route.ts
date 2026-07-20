import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { insertFollowUpSequenceRows } from "@/lib/data/emails";
import { sanitizeStoredEmailHtml } from "@/lib/ai/sanitize-email-html";
import { z } from "zod";

const getFollowUpsQuerySchema = z.object({
  contactId: z.coerce.number(),
});

/**
 * GET /api/email-follow-ups?contactId=123
 * Returns follow-up sequences for a contact.
 */
export const GET = withApiHandler({
  querySchema: getFollowUpsQuerySchema,
  handler: async ({ user, query }) => {
    const service = createSupabaseServiceClient();

    const { data: sequences } = await service
      .from("email_follow_ups")
      .select(`
        id, status, original_subject, original_sent_at,
        email_follow_up_messages(id, sequence_number, status, scheduled_send_at, sent_at)
      `)
      .eq("user_id", user.id)
      .eq("contact_id", query.contactId)
      .order("created_at", { ascending: false })
      .limit(5);

    return {
      sequences: (sequences || []).map((s) => ({
        id: s.id,
        status: s.status,
        original_subject: s.original_subject,
        original_sent_at: s.original_sent_at,
        messages: (s.email_follow_up_messages || []).sort(
          (a, b) => a.sequence_number - b.sequence_number
        ),
      })),
    };
  },
});

// CAR-143 (R5.1): recipient/subject strings end up interpolated into MIME
// headers by the send cron — reject CR/LF at the boundary.
const headerSafeString = z.string().regex(/^[^\r\n]*$/, "must not contain line breaks");

const createFollowUpsSchema = z.object({
  contactId: z.number().int().positive(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  scheduledEmailId: z.number().nullable().optional(),
  recipientEmail: headerSafeString,
  contactName: z.string().nullable(),
  originalSubject: headerSafeString,
  originalSentAt: z.string(),
  timezoneOffsetMinutes: z.number(), // client's new Date().getTimezoneOffset()
  followUps: z.array(z.object({
    subject: headerSafeString,
    bodyHtml: z.string(),
    delayDays: z.number().int().positive(),
  })),
});

/**
 * POST /api/email-follow-ups
 * Creates a follow-up sequence with individual message records.
 */
export const POST = withApiHandler({
  schema: createFollowUpsSchema,
  handler: async ({ user, body }) => {
    const {
      contactId, threadId, messageId, scheduledEmailId,
      recipientEmail, contactName, originalSubject, originalSentAt,
      timezoneOffsetMinutes, followUps,
    } = body;

    const service = createSupabaseServiceClient();

    // Build message rows (follow_up_id is stamped by the shared insert).
    // Compute 9:05 AM in user's local timezone as UTC:
    // 9:05 AM local = 9:05 UTC + offsetMinutes (getTimezoneOffset returns minutes BEHIND UTC)
    const sendBase = new Date(originalSentAt);
    const messages = followUps.map((fu, i) => {
      const sendAt = new Date(sendBase.getTime() + fu.delayDays * 24 * 60 * 60 * 1000);
      // Set to 9:05 AM UTC, then adjust for user's timezone offset
      sendAt.setUTCHours(9, 5, 0, 0);
      sendAt.setUTCMinutes(sendAt.getUTCMinutes() + timezoneOffsetMinutes);

      return {
        follow_up_id: 0,
        sequence_number: i + 1,
        send_after_days: fu.delayDays,
        subject: fu.subject,
        // The cron auto-sends stored body_html verbatim — sanitize at the
        // storage chokepoint (CAR-143, R5.2)
        body_html: sanitizeStoredEmailHtml(fu.bodyHtml),
        status: "pending" as const,
        scheduled_send_at: sendAt.toISOString(),
      };
    });

    // Shared parent+messages insert with parent rollback on message failure
    // (CAR-151): same rows the gmail flow and MCP schedule_follow_ups write.
    const sequenceId = await insertFollowUpSequenceRows(
      service,
      user.id,
      {
        originalGmailMessageId: messageId || null,
        threadId: threadId || null,
        recipientEmail,
        contactName,
        originalSubject,
        originalSentAt,
        contactId,
        scheduledEmailId: scheduledEmailId || null,
      },
      messages,
    );

    return { sequenceId, messagesCreated: messages.length };
  },
});
