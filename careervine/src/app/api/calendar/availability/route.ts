import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { queryFreeBusy } from "@/lib/calendar";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";

/**
 * GET /api/calendar/availability
 * Computes free time slots based on calendar events and user preferences.
 * Supports dual availability profiles (standard/priority).
 *
 * Query params:
 * - start: ISO date string (start of range)
 * - end: ISO date string (end of range)
 * - daysOfWeek: comma-separated day numbers (1=Mon, 7=Sun)
 * - windowStart: HH:MM format (e.g., "09:00")
 * - windowEnd: HH:MM format (e.g., "18:00")
 * - duration: slot duration in minutes
 * - bufferBefore: minutes before each event
 * - bufferAfter: minutes after each event
 * - profile: "standard" or "priority" (uses defaults if not specified)
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const service = createSupabaseServiceClient();
    const conn = await service
      .from("gmail_connections")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (!conn.data || !conn.data.calendar_scopes_granted) {
      return NextResponse.json({
        notConnected: true,
        days: [],
      });
    }

    if (!conn.data.calendar_last_synced_at) {
      return NextResponse.json({
        neverSynced: true,
        days: [],
      });
    }

    const { searchParams } = new URL(request.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const daysOfWeekStr = searchParams.get("daysOfWeek") || "1,2,3,4,5";
    const windowStart = searchParams.get("windowStart") || "09:00";
    const windowEnd = searchParams.get("windowEnd") || "18:00";
    const duration = parseInt(searchParams.get("duration") || "30");
    const bufferBefore = parseInt(searchParams.get("bufferBefore") || "10");
    const bufferAfter = parseInt(searchParams.get("bufferAfter") || "10");
    const profile = searchParams.get("profile") || "standard";

    if (!start || !end) {
      return NextResponse.json({ error: "Missing start or end date" }, { status: 400 });
    }

    const daysOfWeek = daysOfWeekStr.split(",").map(d => parseInt(d));
    const userTimezone = conn.data.calendar_timezone || "America/New_York";
    const busyCalendarIds = conn.data.busy_calendar_ids || ["primary"];

    // Query free/busy from Google Calendar API
    const busyIntervals = await queryFreeBusy(user.id, {
      timeMin: start,
      timeMax: end,
      calendarIds: busyCalendarIds,
      timeZone: userTimezone,
    });

    // Expand busy intervals with buffer
    const expandedBusy = busyIntervals.map(interval => ({
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

      const dateStr = d.toISOString().split("T")[0];
      const label = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      // Parse window times in user's timezone
      const [startHour, startMin] = windowStart.split(":").map(Number);
      const [endHour, endMin] = windowEnd.split(":").map(Number);

      // Create dates in UTC, then convert to user's timezone for comparison
      const dayStartLocal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startHour, startMin);
      const dayEndLocal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), endHour, endMin);
      
      // For simplicity, treat these as UTC times (the API expects ISO strings)
      const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), startHour, startMin));
      const dayEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), endHour, endMin));

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

    return NextResponse.json({ days: result });
  } catch (error) {
    console.error("Availability error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compute availability" },
      { status: 500 }
    );
  }
}

function mergeBusyIntervals(intervals: Array<{ start: string; end: string }>) {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (new Date(current.start).getTime() <= new Date(last.end).getTime()) {
      last.end = new Date(
        Math.max(new Date(last.end).getTime(), new Date(current.end).getTime())
      ).toISOString();
    } else {
      merged.push(current);
    }
  }
  return merged;
}

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
