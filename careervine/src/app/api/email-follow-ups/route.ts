import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
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
      sequences: (sequences || []).map((s: any) => ({
        id: s.id,
        status: s.status,
        original_subject: s.original_subject,
        original_sent_at: s.original_sent_at,
        messages: (s.email_follow_up_messages || []).sort(
          (a: any, b: any) => a.sequence_number - b.sequence_number
        ),
      })),
    };
  },
});

const createFollowUpsSchema = z.object({
  contactId: z.number().int().positive(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
  scheduledEmailId: z.number().nullable().optional(),
  recipientEmail: z.string(),
  contactName: z.string().nullable(),
  originalSubject: z.string(),
  originalSentAt: z.string(),
  timezoneOffsetMinutes: z.number(), // client's new Date().getTimezoneOffset()
  followUps: z.array(z.object({
    subject: z.string(),
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

    // Create the parent sequence record
    const { data: sequence, error: seqErr } = await service
      .from("email_follow_ups")
      .insert({
        user_id: user.id,
        original_gmail_message_id: messageId || null,
        thread_id: threadId || null,
        recipient_email: recipientEmail,
        contact_name: contactName,
        original_subject: originalSubject,
        original_sent_at: originalSentAt,
        contact_id: contactId,
        scheduled_email_id: scheduledEmailId || null,
        status: "active",
      })
      .select("id")
      .single();

    if (seqErr || !sequence) {
      console.error("[follow-ups] Failed to create sequence:", seqErr);
      throw seqErr || new Error("Failed to create follow-up sequence");
    }

    // Create individual message records
    // Compute 9:05 AM in user's local timezone as UTC:
    // 9:05 AM local = 9:05 UTC + offsetMinutes (getTimezoneOffset returns minutes BEHIND UTC)
    const sendBase = new Date(originalSentAt);
    const messages = followUps.map((fu, i) => {
      const sendAt = new Date(sendBase.getTime() + fu.delayDays * 24 * 60 * 60 * 1000);
      // Set to 9:05 AM UTC, then adjust for user's timezone offset
      sendAt.setUTCHours(9, 5, 0, 0);
      sendAt.setUTCMinutes(sendAt.getUTCMinutes() + timezoneOffsetMinutes);

      return {
        follow_up_id: sequence.id,
        sequence_number: i + 1,
        send_after_days: fu.delayDays,
        subject: fu.subject,
        body_html: fu.bodyHtml,
        status: "pending" as const,
        scheduled_send_at: sendAt.toISOString(),
      };
    });

    const { error: msgErr } = await service
      .from("email_follow_up_messages")
      .insert(messages);

    if (msgErr) {
      console.error("[follow-ups] Failed to create messages:", msgErr);
      // Clean up orphaned sequence
      await service.from("email_follow_ups").delete().eq("id", sequence.id);
      throw msgErr;
    }

    return { sequenceId: sequence.id, messagesCreated: messages.length };
  },
});
