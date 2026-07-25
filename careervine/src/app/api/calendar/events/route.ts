import { withApiHandler, type InferApiResponse } from "@/lib/api-handler";
import { calendarEventsQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { parseCalendarAttendees } from "@/lib/calendar-attendees";

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

    // `attendees` is `jsonb`, so the generated row type is `Json` and the column
    // can hold anything, while `app/calendar/page.tsx` types it
    // `Array<{email;name;responseStatus}>` and dereferences `.length`, `.some`,
    // `.map` and `.slice` in six places. Those sit in the top-level render,
    // outside the page's only SectionBoundary, so a bad value blanks the whole
    // route via the error boundary.
    //
    // `parseCalendarAttendees` rather than a local `?? []` (CAR-191 review):
    // its header designates it "the one place that turns the stored Json into
    // typed attendees, so every surface reading them narrows identically instead
    // of each casting its own way", and `??` only substitutes null/undefined —
    // a stored `"x"`, `{}` or `7` would pass straight through to the same crash
    // this is meant to prevent. It also makes the inferred response type real
    // `CalendarAttendee[]` instead of `Json`.
    //
    // No writer produces a bad value today (sync, create-event and the MCP tool
    // all store an array), so this is a latent trap, not a live bug — it
    // surfaced when CAR-191's E2E seed wrote a null directly.
    return {
      events: (data || []).map((e) => ({ ...e, attendees: parseCalendarAttendees(e.attendees) })),
    };
  },
});

/**
 * Success shape, inferred from the handler above (CAR-158, F24). `data` comes
 * from a typed `select("*")` on calendar_events, so the element type is the
 * generated row — which is what lets the dashboard drop its `e: any`.
 * Type-only, so it is erased at compile time.
 */
export type CalendarEventsResponse = InferApiResponse<typeof GET>;
