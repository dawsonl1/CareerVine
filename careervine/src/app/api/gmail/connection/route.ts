import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/gmail/connection
 * Fetches the current Gmail/Calendar connection status and settings for the user.
 *
 * The app shell's single `gmail_connections` read (CAR-229). The column list is
 * deliberately a superset of `getGmailConnection()` in `lib/data/users.ts`, so
 * a shell consumer never has a reason to issue a second, narrower query —
 * everything subscribes to the one `useGmailConnection()` store instead. Adding
 * a column here is cheap; adding a second shell-level fetch is not.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    const { data, error } = await service
      .from("gmail_connections")
      .select("id, gmail_address, last_gmail_sync_at, created_at, send_scope_granted, calendar_scopes_granted, calendar_last_synced_at, availability_standard, availability_priority, calendar_list, busy_calendar_ids, calendar_timezone")
      .eq("user_id", user.id)
      .single();

    if (error || !data) {
      return { connection: null };
    }

    return { connection: data };
  },
});
