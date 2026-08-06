import { withApiHandler } from "@/lib/api-handler";
import { gmailFollowUpQuerySchema, gmailFollowUpCreateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { buildFollowUpMessageRows } from "@/lib/follow-up-helpers";
import { insertFollowUpSequenceRows } from "@/lib/data/emails";
import { resolveUserTimeZone } from "@/lib/user-timezone";
import { sanitizeStoredEmailHtml } from "@/lib/ai/sanitize-email-html";

/**
 * GET /api/gmail/follow-ups?threadId=xxx
 * Returns follow-up sequences for a thread or all active ones.
 */
export const GET = withApiHandler({
  querySchema: gmailFollowUpQuerySchema,
  handler: async ({ user, query }) => {
    const { threadId } = query;
    const service = createSupabaseServiceClient();

    let dbQuery = service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (threadId) {
      dbQuery = dbQuery.eq("thread_id", threadId);
    }

    const { data, error } = await dbQuery;
    if (error) throw error;

    return { followUps: data || [] };
  },
});

/**
 * POST /api/gmail/follow-ups
 * Creates a new follow-up sequence with one or more scheduled messages.
 */
export const POST = withApiHandler({
  schema: gmailFollowUpCreateSchema,
  handler: async ({ user, body, track, request }) => {
    const {
      originalGmailMessageId,
      threadId,
      recipientEmail,
      contactName,
      originalSubject,
      originalSentAt,
      scheduledEmailId,
      messages,
    } = body;

    const service = createSupabaseServiceClient();

    // Build the message rows first (follow_up_id is stamped by the shared
    // insert). The cron auto-sends stored body_html verbatim — sanitize at
    // the storage chokepoint (CAR-143, R5.2).
    // Send times are local to the user's own zone (CAR-215). Resolved from the
    // request header first, which is the same browser that just picked them.
    const timeZone = await resolveUserTimeZone(service, user.id, request.headers);

    const msgRows = buildFollowUpMessageRows(
      0,
      messages.map((m) => ({ ...m, bodyHtml: sanitizeStoredEmailHtml(m.bodyHtml) })),
      new Date(originalSentAt),
      timeZone,
    );

    // Shared parent+messages insert with parent rollback on message failure
    // (CAR-151): same rows the MCP schedule_follow_ups tool writes.
    const followUpId = await insertFollowUpSequenceRows(
      service,
      user.id,
      {
        // Blank -> null, never a placeholder: a sequence waiting on an unsent
        // scheduled email stays dormant on `thread_id is null` until the send
        // cron back-fills the real ids (see gmailFollowUpCreateSchema).
        originalGmailMessageId: originalGmailMessageId || null,
        threadId: threadId || null,
        recipientEmail,
        contactName: contactName || null,
        originalSubject: originalSubject || null,
        originalSentAt,
        scheduledEmailId: scheduledEmailId || null,
      },
      msgRows,
    );

    // Fetch the complete follow-up with messages
    const { data: complete } = await service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("id", followUpId)
      .eq("user_id", user.id)
      .single();

    track("follow_up_sequence_created", { steps: messages.length });
    return { followUp: complete };
  },
});
