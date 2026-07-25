import { withApiHandler, type InferApiResponse } from "@/lib/api-handler";
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

    // `attendees` is nullable in the schema but every consumer treats it as an
    // array — `app/calendar/page.tsx` types it `Array<...>` and dereferences
    // `.length` in four places. No writer produces a null today (the sync route,
    // create-event and the MCP tool all pass an array or `[]`), so this is a
    // latent trap rather than a live bug; it surfaced when CAR-191's E2E seed
    // wrote one directly and the calendar page died to its route-level error
    // boundary — a blank "Something went wrong." for the entire page, from one
    // null column. Normalizing at the read boundary costs nothing and makes the
    // client type honest, which is cheaper than a null-guard at every use site.
    return { events: (data || []).map((e) => ({ ...e, attendees: e.attendees ?? [] })) };
  },
});

/**
 * Success shape, inferred from the handler above (CAR-158, F24). `data` comes
 * from a typed `select("*")` on calendar_events, so the element type is the
 * generated row — which is what lets the dashboard drop its `e: any`.
 * Type-only, so it is erased at compile time.
 */
export type CalendarEventsResponse = InferApiResponse<typeof GET>;
