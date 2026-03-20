import { withApiHandler, ApiError } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/connection
 * Fetches the current Gmail/Calendar connection status and settings for the user.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("gmail_connections")
      .select("id, gmail_address, last_gmail_sync_at, created_at, calendar_scopes_granted, calendar_last_synced_at, availability_standard, availability_priority, calendar_list, busy_calendar_ids, calendar_timezone")
      .eq("user_id", user.id)
      .single();

    if (error || !data) {
      return { connection: null };
    }

    return { connection: data };
  },
});
