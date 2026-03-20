import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/unread
 * Returns the count of unread inbound emails for the current user.
 * Lightweight endpoint used by the navigation badge.
 */
export const GET = withApiHandler({
  authOptional: true,
  handler: async ({ user }) => {
    if (!user) return { count: 0 };
    const service = createSupabaseServiceClient();
    const { count, error } = await service
      .from("email_messages")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false)
      .eq("is_trashed", false)
      .eq("is_hidden", false)
      .eq("direction", "inbound");

    if (error) throw error;

    return { count: count || 0 };
  },
});
