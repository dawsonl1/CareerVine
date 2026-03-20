import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * DELETE /api/gmail/drafts/:id
 * Delete a specific draft by ID.
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const { id } = params;

    const service = createSupabaseServiceClient();
    const { error } = await service
      .from("email_drafts")
      .delete()
      .eq("id", parseInt(id))
      .eq("user_id", user.id);

    if (error) throw error;
    return { success: true };
  },
});
