import { withApiHandler } from "@/lib/api-handler";
import { gmailScheduleQuerySchema, gmailScheduleCreateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { ScheduledEmailStatus } from "@/lib/constants";
import { insertScheduledEmail } from "@/lib/data/emails";

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
      // failed = stale send claim swept by the cron (CAR-134); shown with a
      // Retry action so it never vanishes silently. 'sending' is transient
      // and intentionally hidden.
      .in("status", [ScheduledEmailStatus.Pending, ScheduledEmailStatus.Failed])
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
  handler: async ({ user, body, track }) => {
    const {
      to, cc, bcc, subject, bodyHtml, scheduledSendAt,
      threadId, inReplyTo, references,
      contactName, matchedContactId,
    } = body;

    const service = createSupabaseServiceClient();

    // Shared insert (CAR-151): same rows the MCP schedule_email tool writes.
    const data = await insertScheduledEmail(service, user.id, {
      to,
      cc,
      bcc,
      subject,
      bodyHtml: bodyHtml || "",
      scheduledSendAt,
      threadId,
      inReplyTo,
      references,
      contactName,
      matchedContactId: matchedContactId || null,
    });

    track("email_scheduled", {
      send_in_hours: Math.max(
        0,
        Math.round((new Date(scheduledSendAt).getTime() - Date.now()) / 3600_000),
      ),
    });
    return { scheduledEmail: data };
  },
});
