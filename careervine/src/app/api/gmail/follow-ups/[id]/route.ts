import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailFollowUpUpdateSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { buildFollowUpMessageRows } from "@/lib/follow-up-helpers";
import { FollowUpStatus, FollowUpMessageStatus } from "@/lib/constants";

/**
 * PUT /api/gmail/follow-ups/[id]
 * Updates the pending messages in a follow-up sequence.
 * Deletes all existing pending messages and replaces them with new ones.
 */
export const PUT = withApiHandler({
  schema: gmailFollowUpUpdateSchema,
  handler: async ({ user, body, params }) => {
    const followUpId = parseInt(params.id, 10);
    if (isNaN(followUpId)) {
      throw new ApiError("Invalid follow-up ID", 400);
    }

    const service = createSupabaseServiceClient();

    // Verify ownership and get original_sent_at
    const { data: followUp } = await service
      .from("email_follow_ups")
      .select("*")
      .eq("id", followUpId)
      .single();

    if (!followUp || followUp.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }

    if (followUp.status !== FollowUpStatus.Active) {
      throw new ApiError("Can only edit active follow-ups", 400);
    }

    const { messages } = body;

    // Delete existing pending messages
    await service
      .from("email_follow_up_messages")
      .delete()
      .eq("follow_up_id", followUpId)
      .eq("status", FollowUpMessageStatus.Pending);

    // Count already-sent messages to offset sequence numbers
    const { count: sentCount } = await service
      .from("email_follow_up_messages")
      .select("id", { count: "exact", head: true })
      .eq("follow_up_id", followUpId);

    // Insert new messages with sequence numbers after any already-sent ones
    const msgRows = buildFollowUpMessageRows(
      followUpId,
      messages,
      new Date(followUp.original_sent_at),
      sentCount ?? 0,
    );

    const { error: msgError } = await service
      .from("email_follow_up_messages")
      .insert(msgRows);

    if (msgError) throw msgError;

    // Update timestamp
    await service
      .from("email_follow_ups")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", followUpId);

    // Return updated follow-up
    const { data: complete } = await service
      .from("email_follow_ups")
      .select("*, email_follow_up_messages(*)")
      .eq("id", followUpId)
      .single();

    return { followUp: complete };
  },
});

/**
 * DELETE /api/gmail/follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const followUpId = parseInt(params.id, 10);
    if (isNaN(followUpId)) {
      throw new ApiError("Invalid follow-up ID", 400);
    }

    const service = createSupabaseServiceClient();

    // Verify ownership
    const { data: followUp } = await service
      .from("email_follow_ups")
      .select("id, user_id")
      .eq("id", followUpId)
      .single();

    if (!followUp || followUp.user_id !== user.id) {
      throw new ApiError("Not found", 404);
    }

    const now = new Date().toISOString();

    // Cancel all pending messages
    await service
      .from("email_follow_up_messages")
      .update({ status: FollowUpMessageStatus.Cancelled })
      .eq("follow_up_id", followUpId)
      .eq("status", FollowUpMessageStatus.Pending);

    // Update the sequence status
    await service
      .from("email_follow_ups")
      .update({ status: FollowUpStatus.CancelledUser, updated_at: now })
      .eq("id", followUpId);

    return { success: true };
  },
});
