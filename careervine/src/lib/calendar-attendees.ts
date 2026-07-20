/**
 * The attendee shape stored on `calendar_events.attendees` (CAR-158).
 *
 * That column is `jsonb`, so the generated row type gives back `Json` — a
 * union that says nothing about the objects inside it. The sync route writes a
 * known shape (see src/app/api/calendar/sync/route.ts), but the database
 * cannot promise that on read: rows predate the current writer, and jsonb
 * accepts anything.
 *
 * `parseCalendarAttendees` is the one place that turns the stored Json into
 * typed attendees, so every surface reading them narrows identically instead
 * of each casting its own way. It drops entries without a usable email rather
 * than throwing: a malformed attendee should cost one row in a list, not the
 * whole day's schedule.
 */

export interface CalendarAttendee {
  email: string;
  name?: string;
  responseStatus?: string;
}

/** Read a string property off an unknown value, or undefined. */
function str(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : undefined;
}

/** Narrow a stored jsonb value into typed attendees, dropping unusable entries. */
export function parseCalendarAttendees(value: unknown): CalendarAttendee[] {
  if (!Array.isArray(value)) return [];
  const out: CalendarAttendee[] = [];
  for (const entry of value) {
    const email = str(entry, "email");
    if (!email) continue;
    out.push({
      email,
      name: str(entry, "name"),
      responseStatus: str(entry, "responseStatus"),
    });
  }
  return out;
}
