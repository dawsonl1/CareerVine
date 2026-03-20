import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/calendar/disconnect
 * Disconnects Calendar from CareerVine (clears calendar_scopes_granted and deletes cached events).
 * Does NOT disconnect Gmail.
 */
export const POST = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();

    // Clear calendar scopes and sync state
    await service
      .from("gmail_connections")
      .update({
        calendar_scopes_granted: false,
        calendar_sync_token: null,
        calendar_last_synced_at: null,
      })
      .eq("user_id", user.id);

    // Delete all cached calendar events for this user
    await service
      .from("calendar_events")
      .delete()
      .eq("user_id", user.id);

    return { success: true };
  },
});
