import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { insertFollowUpSequenceRows } from "@/lib/data/emails";
import { buildFollowUpMessageRows } from "@/lib/follow-up-helpers";
import { resolveUserTimeZone } from "@/lib/user-timezone";
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
  // CAR-215 removed timezoneOffsetMinutes: an offset captured at creation
  // time is wrong for any step on the far side of a DST boundary. The zone
  // now arrives on the X-CV-Timezone header. Zod strips unknown keys, so a
  // cached older client still sending the field is harmless.
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
  handler: async ({ user, body, request }) => {
    const {
      contactId, threadId, messageId, scheduledEmailId,
      recipientEmail, contactName, originalSubject, originalSentAt,
      followUps,
    } = body;

    const service = createSupabaseServiceClient();

    // Build message rows (follow_up_id is stamped by the shared insert).
    //
    // CAR-215: this used to bake the browser's `getTimezoneOffset()` into every
    // step. An offset is a snapshot, not a zone, so a sequence created in EDT
    // with a step landing after November's change fired at 8:05 AM instead of
    // 9:05. It also disagreed with the sibling route (POST /api/gmail/follow-ups),
    // which scheduled the same feature at 09:00 UTC (2 AM Mountain). Both now go
    // through the shared, zone-aware builder.
    const timeZone = await resolveUserTimeZone(service, user.id, request.headers);
    const messages = buildFollowUpMessageRows(
      0,
      followUps.map((fu) => ({
        sendAfterDays: fu.delayDays,
        subject: fu.subject,
        // The cron auto-sends stored body_html verbatim — sanitize at the
        // storage chokepoint (CAR-143, R5.2)
        bodyHtml: sanitizeStoredEmailHtml(fu.bodyHtml),
      })),
      new Date(originalSentAt),
      timeZone,
    );

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
