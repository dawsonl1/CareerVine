/**
 * POST /api/gmail/ai-followups/[id]/send
 *
 * Sends an AI follow-up draft via Gmail and updates its status.
 * Reuses the shared sendEmail utility and caches the sent message.
 */

import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendEmail, getConnection } from "@/lib/gmail";
import { AiFollowUpDraftStatus, EmailDirection, GmailLabel } from "@/lib/constants";

export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const draftId = Number(params.id);
    if (isNaN(draftId)) throw new ApiError("Invalid draft ID", 400);

    const service = createSupabaseServiceClient();

    // Fetch the draft and verify ownership
    const { data: draft } = await service
      .from("ai_follow_up_drafts")
      .select("*")
      .eq("id", draftId)
      .single();

    if (!draft || draft.user_id !== user.id) {
      throw new ApiError("Draft not found", 404);
    }

    if (draft.status !== AiFollowUpDraftStatus.Pending) {
      throw new ApiError("Draft has already been sent or dismissed", 400);
    }

    if (!draft.recipient_email) {
      throw new ApiError("No recipient email on this draft", 400);
    }

    // Send the email
    const sendOpts: {
      to: string;
      subject: string;
      bodyHtml: string;
      threadId?: string;
    } = {
      to: draft.recipient_email,
      subject: draft.subject,
      bodyHtml: draft.body_html,
    };

    if (draft.send_as_reply && draft.reply_thread_id) {
      sendOpts.threadId = draft.reply_thread_id;
    }

    const result = await sendEmail(user.id, sendOpts);

    // Cache the sent message (same pattern as gmail/send/route.ts)
    const toAddr = draft.recipient_email.trim().toLowerCase();

    const conn = await getConnection(user.id);

    await service.from("email_messages").upsert(
      {
        user_id: user.id,
        gmail_message_id: result.messageId,
        thread_id: result.threadId || null,
        subject: draft.subject,
        snippet: draft.body_html.replace(/<[^>]*>/g, "").slice(0, 200),
        from_address: conn?.gmail_address?.toLowerCase() || "",
        to_addresses: [toAddr],
        date: new Date().toISOString(),
        label_ids: [GmailLabel.Sent],
        is_read: true,
        is_trashed: false,
        is_hidden: false,
        direction: EmailDirection.Outbound,
        matched_contact_id: draft.contact_id,
      },
      { onConflict: "user_id,gmail_message_id", ignoreDuplicates: false },
    );

    // Create an interaction record
    await service.from("interactions").insert({
      contact_id: draft.contact_id,
      interaction_date: new Date().toISOString(),
      interaction_type: "email",
      summary: `Sent AI-suggested follow-up: ${draft.extracted_topic}`,
    });

    // Update draft status
    await service
      .from("ai_follow_up_drafts")
      .update({
        status: AiFollowUpDraftStatus.Sent,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId);

    return {
      success: true,
      messageId: result.messageId,
      threadId: result.threadId,
    };
  },
});
