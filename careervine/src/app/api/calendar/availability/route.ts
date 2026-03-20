import { withApiHandler, ApiError } from "@/lib/api-handler";
import { calendarAvailabilityQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { queryFreeBusy, DEFAULT_TIMEZONE, mergeBusyIntervals } from "@/lib/calendar";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

/**
 * GET /api/calendar/availability
 * Computes free time slots based on calendar events and user preferences.
 * Supports dual availability profiles (standard/priority).
 */
export const GET = withApiHandler({
  querySchema: calendarAvailabilityQuerySchema,
  handler: async ({ user, query }) => {
    const service = createSupabaseServiceClient();
    const conn = await service
      .from("gmail_connections")
      .select("calendar_scopes_granted, calendar_last_synced_at, calendar_timezone, busy_calendar_ids")
      .eq("user_id", user.id)
      .single();

    if (!conn.data || !conn.data.calendar_scopes_granted) {
      return {
        notConnected: true,
        days: [],
      };
    }

    if (!conn.data.calendar_last_synced_at) {
      return {
        neverSynced: true,
        days: [],
      };
    }

    const {
      start,
      end,
      daysOfWeek: daysOfWeekStr = "1,2,3,4,5",
      windowStart = "09:00",
      windowEnd = "18:00",
      duration = 30,
      bufferBefore = 10,
      bufferAfter = 10,
    } = query;

    const daysOfWeek = daysOfWeekStr.split(",").map((d: string) => parseInt(d));
    const userTimezone = conn.data.calendar_timezone || DEFAULT_TIMEZONE;
    const busyCalendarIds = conn.data.busy_calendar_ids || ["primary"];

    // Query free/busy from Google Calendar API
    const busyIntervals = await queryFreeBusy(user.id, {
      timeMin: start,
      timeMax: end,
      calendarIds: busyCalendarIds,
      timeZone: userTimezone,
    });

    // Expand busy intervals with buffer
    const expandedBusy = busyIntervals.map((interval: { start: string; end: string }) => ({
      start: new Date(new Date(interval.start).getTime() - bufferBefore * 60000).toISOString(),
      end: new Date(new Date(interval.end).getTime() + bufferAfter * 60000).toISOString(),
    }));

    // Merge overlapping intervals
    const mergedBusy = mergeBusyIntervals(expandedBusy);

    // Compute free slots for each day
    const result: Array<{
      date: string;
      label: string;
      slots: string[];
    }> = [];

    const startDate = new Date(start);
    const endDate = new Date(end);

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay(); // Convert to 1=Mon, 7=Sun
      if (!daysOfWeek.includes(dayOfWeek)) continue;

      // Get the date string in the user's timezone (not UTC) to avoid off-by-one days
      const dateStr = formatInTimeZone(d, userTimezone, "yyyy-MM-dd");
      const label = formatInTimeZone(d, userTimezone, "EEE, MMM d");

      // Build window boundaries as "HH:MM in userTimezone" → UTC Date objects
      const dayStart = fromZonedTime(`${dateStr}T${windowStart}`, userTimezone);
      const dayEnd = fromZonedTime(`${dateStr}T${windowEnd}`, userTimezone);

      // Find free slots
      const slots = computeFreeSlots(dayStart, dayEnd, mergedBusy, duration, userTimezone);

      if (slots.length > 0) {
        result.push({
          date: dateStr,
          label,
          slots,
        });
      }
    }

    return { days: result };
  },
});

function computeFreeSlots(
  dayStart: Date,
  dayEnd: Date,
  busyIntervals: Array<{ start: string; end: string }>,
  duration: number,
  timezone: string
): string[] {
  const slots: string[] = [];
  let cursor = dayStart;

  for (const busy of busyIntervals) {
    const busyStart = new Date(busy.start);
    const busyEnd = new Date(busy.end);

    // Skip if busy period is outside this day
    if (busyEnd <= dayStart || busyStart >= dayEnd) continue;

    // Add free slot before this busy period
    if (cursor < busyStart) {
      const slotStart = new Date(Math.max(cursor.getTime(), dayStart.getTime()));
      const slotEnd = new Date(Math.min(busyStart.getTime(), dayEnd.getTime()));

      if (slotEnd.getTime() - slotStart.getTime() >= duration * 60000) {
        slots.push(formatSlot(slotStart, slotEnd, timezone));
      }
    }

    cursor = new Date(Math.max(cursor.getTime(), busyEnd.getTime()));
  }

  // Add final free slot
  if (cursor < dayEnd) {
    const slotStart = new Date(Math.max(cursor.getTime(), dayStart.getTime()));
    const slotEnd = dayEnd;

    if (slotEnd.getTime() - slotStart.getTime() >= duration * 60000) {
      slots.push(formatSlot(slotStart, slotEnd, timezone));
    }
  }

  return slots;
}

function formatSlot(start: Date, end: Date, timezone: string): string {
  const startStr = formatInTimeZone(start, timezone, "h:mm a");
  const endStr = formatInTimeZone(end, timezone, "h:mm a");
  return `${startStr} – ${endStr}`;
}
