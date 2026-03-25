import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/onboarding/status
 * Returns the user's onboarding row, or null if none exists.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();

    const { data, error } = await service
      .from("user_onboarding")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 = no rows found — that's fine, return null
      throw new Error(`Failed to fetch onboarding status: ${error.message}`);
    }

    return { onboarding: data ?? null };
  },
});
