import { withApiHandler } from "@/lib/api-handler";
import { calendarEventsQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

/**
 * GET /api/calendar/events?start=...&end=...
 * Fetches calendar events from the local cache for a date range.
 */
export const GET = withApiHandler({
  querySchema: calendarEventsQuerySchema,
  handler: async ({ user, query }) => {
    const { start, end } = query;

    const service = createSupabaseServiceClient();
    let q = service
      .from("calendar_events")
      .select("*")
      .eq("user_id", user.id)
      .order("start_at", { ascending: true });

    if (start) {
      q = q.gte("start_at", start);
    }
    if (end) {
      q = q.lte("start_at", end);
    }

    const { data, error } = await q;

    if (error) throw error;

    return { events: data || [] };
  },
});
