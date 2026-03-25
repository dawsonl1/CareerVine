import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * DELETE /api/email-follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const id = Number(params.id);
    const service = createSupabaseServiceClient();

    // Cancel all pending messages
    await service
      .from("email_follow_up_messages")
      .update({ status: "cancelled" })
      .eq("follow_up_id", id)
      .eq("status", "pending");

    // Cancel the sequence
    await service
      .from("email_follow_ups")
      .update({ status: "cancelled_user", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);

    return { success: true };
  },
});
