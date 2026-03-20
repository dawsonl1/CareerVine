import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * DELETE /api/gmail/templates/:id
 */
export const DELETE = withApiHandler({
  handler: async ({ user, params }) => {
    const { id } = params;

    const service = createSupabaseServiceClient();
    const { error } = await service
      .from("email_templates")
      .delete()
      .eq("id", parseInt(id))
      .eq("user_id", user.id);

    if (error) throw error;
    return { success: true };
  },
});
