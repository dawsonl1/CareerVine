import { withApiHandler } from "@/lib/api-handler";
import { gmailScheduleQuerySchema, gmailScheduleCreateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus } from "@/lib/constants";

/**
 * GET /api/gmail/schedule?contactId=xxx
 * Returns pending scheduled emails, optionally filtered by contact.
 */
export const GET = withApiHandler({
  querySchema: gmailScheduleQuerySchema,
  handler: async ({ user, query }) => {
    const { contactId } = query;
    const service = createSupabaseServiceClient();

    let dbQuery = service
      .from("scheduled_emails")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", ScheduledEmailStatus.Pending)
      .order("scheduled_send_at", { ascending: true });

    if (contactId) {
      dbQuery = dbQuery.eq("matched_contact_id", parseInt(contactId, 10));
    }

    const { data, error } = await dbQuery;
    if (error) throw error;

    return { scheduledEmails: data || [] };
  },
});

/**
 * POST /api/gmail/schedule
 * Creates a new scheduled email.
 */
export const POST = withApiHandler({
  schema: gmailScheduleCreateSchema,
  handler: async ({ user, body }) => {
    const {
      to, cc, bcc, subject, bodyHtml, scheduledSendAt,
      threadId, inReplyTo, references,
      contactName, matchedContactId,
    } = body;

    const service = createSupabaseServiceClient();

    const { data, error } = await service
      .from("scheduled_emails")
      .insert({
        user_id: user.id,
        recipient_email: to,
        cc: cc || null,
        bcc: bcc || null,
        subject,
        body_html: bodyHtml || "",
        thread_id: threadId || null,
        in_reply_to: inReplyTo || null,
        references_header: references || null,
        scheduled_send_at: scheduledSendAt,
        status: ScheduledEmailStatus.Pending,
        contact_name: contactName || null,
        matched_contact_id: matchedContactId || null,
      })
      .select()
      .single();

    if (error) throw error;

    return { scheduledEmail: data };
  },
});
