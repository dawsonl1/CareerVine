import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * DELETE /api/email-follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const id = Number(params.id);
    const service = createSupabaseServiceClient();

    // Verify ownership first
    const { data: sequence } = await service
      .from("email_follow_ups")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (!sequence) {
      throw new ApiError("Follow-up sequence not found", 404);
    }

    // Cancel all open messages — pending AND awaiting_review, so a parked
    // confirm-to-send step is never orphaned (CAR-102). Ownership verified above.
    await service
      .from("email_follow_up_messages")
      .update({ status: "cancelled" })
      .eq("follow_up_id", id)
      .in("status", ["pending", "awaiting_review"]);

    // Cancel the sequence
    await service
      .from("email_follow_ups")
      .update({ status: "cancelled_user", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);

    return { success: true };
  },
});
