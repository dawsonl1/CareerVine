import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/discovery/candidates/[id]/dismiss
 * Sticky dismiss (plan 41): the candidate never resurfaces — re-discovery
 * bumps last_seen_at but never resets status.
 */
export const POST = withApiHandler({
  handler: async ({ user, params }) => {
    const candidateId = Number(params.id);
    if (!Number.isFinite(candidateId)) throw new ApiError("Invalid candidate id", 400);

    const service = createSupabaseServiceClient();
    const { count, error } = await service
      .from("discovery_candidates")
      .update({ status: "dismissed" }, { count: "exact" })
      .eq("id", candidateId)
      .eq("user_id", user.id)
      .eq("status", "new");
    if (error) throw new Error(`dismiss failed: ${error.message}`);
    if (!count) throw new ApiError("Candidate not found or already handled", 404);
    return { success: true };
  },
});
