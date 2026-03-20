import { withApiHandler } from "@/lib/api-handler";
import { calendarBusyCalendarsSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * POST /api/calendar/busy-calendars
 * Saves the user's selected calendar IDs that count as "busy" for availability.
 * Body: { busyCalendarIds: string[] }
 */
export const POST = withApiHandler({
  schema: calendarBusyCalendarsSchema,
  handler: async ({ user, body }) => {
    const { busyCalendarIds } = body;

    const service = createSupabaseServiceClient();
    await service
      .from("gmail_connections")
      .update({ busy_calendar_ids: busyCalendarIds })
      .eq("user_id", user.id);

    return { success: true };
  },
});
