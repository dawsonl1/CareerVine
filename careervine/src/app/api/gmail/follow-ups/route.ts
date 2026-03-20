import { withApiHandler } from "@/lib/api-handler";
import { gmailFollowUpQuerySchema, gmailFollowUpCreateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { buildFollowUpMessageRows } from "@/lib/follow-up-helpers";
import { FollowUpStatus } from "@/lib/constants";

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
  handler: async ({ user, body }) => {
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

    // Create the follow-up sequence
    const { data: followUp, error: fuError } = await service
      .from("email_follow_ups")
      .insert({
        user_id: user.id,
        original_gmail_message_id: originalGmailMessageId,
        thread_id: threadId,
        recipient_email: recipientEmail,
        contact_name: contactName || null,
        original_subject: originalSubject || null,
        original_sent_at: originalSentAt,
        status: FollowUpStatus.Active,
        scheduled_email_id: scheduledEmailId || null,
      })
      .select()
      .single();

    if (fuError) throw fuError;

    // Create the individual follow-up messages
    const msgRows = buildFollowUpMessageRows(
      followUp.id,
      messages,
      new Date(originalSentAt),
    );

    const { error: msgError } = await service
      .from("email_follow_up_messages")
      .insert(msgRows);

    if (msgError) throw msgError;

    // Fetch the complete follow-up with messages
    const { data: complete } = await service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("id", followUp.id)
      .single();

    return { followUp: complete };
  },
});
