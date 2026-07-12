import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { sendTrackedEmail, SendPolicyError } from "@/lib/email-send";
import { recordThreadReply } from "@/lib/follow-up-reply";

const schema = z.object({
  messageId: z.number().int(),
  replied: z.boolean(),
});

/**
 * POST /api/gmail/follow-ups/confirm — confirm-to-send for a free-tier follow-up
 * (CAR-102). Free users' due follow-ups are parked as 'awaiting_review' by the
 * cron; the user confirms each one, which doubles as the reply check they can't
 * get automatically:
 *   replied=true  -> they responded: cancel the sequence, activate the contact,
 *                    fire reply_received (via the shared, idempotent helper).
 *   replied=false -> no reply yet: send this follow-up now (gmail.send only).
 * Sending needs no live-read scope, so this route is not capability-gated.
 */
export const POST = withApiHandler<z.infer<typeof schema>>({
  schema,
  handler: async ({ user, body }) => {
    const { messageId, replied } = body;
    const service = createSupabaseServiceClient();

    const { data: msgData } = await service
      .from("email_follow_up_messages")
      .select(
        "id, subject, body_html, status, follow_up_id, " +
          "email_follow_ups!inner(user_id, thread_id, recipient_email, original_gmail_message_id, status)",
      )
      .eq("id", messageId)
      .maybeSingle();

    const msg = msgData as unknown as {
      status: string;
      subject: string;
      body_html: string;
      follow_up_id: number;
      email_follow_ups?: {
        user_id: string;
        thread_id: string;
        recipient_email: string;
        original_gmail_message_id: string | null;
        status: string;
      };
    } | null;
    const parent = msg?.email_follow_ups;

    if (!msg || !parent || parent.user_id !== user.id) {
      throw new ApiError("Follow-up not found", 404);
    }
    if (msg.status !== "awaiting_review") {
      throw new ApiError("This follow-up is not awaiting review.", 400);
    }
    // Defense-in-depth: an awaiting_review message whose parent sequence is no
    // longer active is orphaned (the sequence was cancelled/completed without
    // this row being cascaded). Never confirm-send or record against it — the
    // portal should refetch and drop it.
    if (parent.status !== "active") {
      throw new ApiError("This follow-up sequence is no longer active.", 409);
    }

    if (replied) {
      // They replied: cancel the sequence (incl. this message) + activate + fire.
      const result = await recordThreadReply(user.id, parent.thread_id, parent.recipient_email);
      return { ok: true, replied: true, alreadyMarked: result.alreadyMarked };
    }

    // No reply: send this follow-up now. Atomic claim prevents a double send.
    const { data: claimed } = await service
      .from("email_follow_up_messages")
      .update({ status: "sending" })
      .eq("id", messageId)
      .eq("status", "awaiting_review")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      throw new ApiError("This follow-up is no longer awaiting review.", 409);
    }

    try {
      await sendTrackedEmail(
        user.id,
        {
          to: parent.recipient_email,
          subject: msg.subject,
          bodyHtml: msg.body_html,
          threadId: parent.thread_id,
          inReplyTo: parent.original_gmail_message_id ?? undefined,
          references: parent.original_gmail_message_id ?? undefined,
        },
        { isFollowUp: true },
      );
    } catch (err) {
      // Revert so the user can retry from the portal.
      await service
        .from("email_follow_up_messages")
        .update({ status: "awaiting_review" })
        .eq("id", messageId);
      const capped = err instanceof SendPolicyError && err.status === 429;
      throw new ApiError(
        capped ? "You have reached today's sending limit. Try again later." : "Could not send the follow-up.",
        capped ? 429 : 400,
      );
    }

    const now = new Date().toISOString();
    await service
      .from("email_follow_up_messages")
      .update({ status: "sent", sent_at: now })
      .eq("id", messageId);

    // Complete the sequence when nothing is left to send or review.
    const { count } = await service
      .from("email_follow_up_messages")
      .select("id", { count: "exact", head: true })
      .eq("follow_up_id", msg.follow_up_id)
      .in("status", ["pending", "sending", "awaiting_review"]);
    if (count === 0) {
      await service
        .from("email_follow_ups")
        .update({ status: "completed", updated_at: now })
        .eq("id", msg.follow_up_id);
    }

    return { ok: true, sent: true };
  },
});
