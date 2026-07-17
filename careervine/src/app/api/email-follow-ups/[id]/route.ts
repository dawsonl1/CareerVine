import { withApiHandler, ApiError } from "@/lib/api-handler";
import { idParamSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { cancelFollowUpSequenceCascade } from "@/lib/data/emails";

/**
 * DELETE /api/email-follow-ups/[id]
 * Cancels a follow-up sequence and all its pending messages.
 */
export const DELETE = withApiHandler({
  paramsSchema: idParamSchema,
  handler: async ({ user, params }) => {
    const id = params.id;
    const service = createSupabaseServiceClient();

    // Verify ownership first (distinguishes 404 from an already-terminal sequence)
    const { data: sequence } = await service
      .from("email_follow_ups")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (!sequence) {
      throw new ApiError("Follow-up sequence not found", 404);
    }

    // Shared active-only cascade (CAR-151): parent CAS first, then every
    // unresolved message — pending, awaiting_review AND expired, so a parked
    // confirm-to-send step or a still-sendable expired one is never orphaned
    // (CAR-102/CAR-105). A completed or already-cancelled sequence is a no-op.
    await cancelFollowUpSequenceCascade(service, user.id, id);

    return { success: true };
  },
});
