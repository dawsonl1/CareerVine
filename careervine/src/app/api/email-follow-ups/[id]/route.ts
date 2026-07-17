import { withApiHandler, ApiError } from "@/lib/api-handler";
import { idParamSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES } from "@/lib/constants";

/**
 * DELETE /api/email-follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export const DELETE = withApiHandler({
  paramsSchema: idParamSchema,
  handler: async ({ user, params }) => {
    const id = params.id;
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

    // Cancel all unresolved messages — pending, awaiting_review AND expired, so a
    // parked confirm-to-send step or a still-sendable expired one is never
    // orphaned (CAR-102/CAR-105). Ownership verified above.
    await service
      .from("email_follow_up_messages")
      .update({ status: "cancelled" })
      .eq("follow_up_id", id)
      .in("status", [...UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES]);

    // Cancel the sequence
    await service
      .from("email_follow_ups")
      .update({ status: "cancelled_user", updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", user.id);

    return { success: true };
  },
});
