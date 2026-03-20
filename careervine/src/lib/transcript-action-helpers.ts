/**
 * Helper functions for extracting action items from transcripts.
 * - Contact matching: maps speaker names to meeting attendees
 * - Due date resolution: converts relative date hints to ISO dates
 */

interface Attendee {
  id: number;
  name: string;
}

/**
 * Match a speaker name from the transcript to a meeting attendee.
 * Returns the matched attendee or null.
 */
export function matchSpeakerToAttendee(
  speakerName: string,
  attendees: Attendee[],
): Attendee | null {
  if (!speakerName || attendees.length === 0) return null;

  const speaker = speakerName.toLowerCase().trim();

  // Exact match
  for (const a of attendees) {
    if (a.name.toLowerCase().trim() === speaker) return a;
  }

  // First name match
  const speakerFirst = speaker.split(/\s+/)[0];
  for (const a of attendees) {
    const attendeeFirst = a.name.toLowerCase().trim().split(/\s+/)[0];
    if (attendeeFirst === speakerFirst && speakerFirst.length > 1) return a;
  }

  // Last name match (for cases like "Smith" matching "John Smith")
  for (const a of attendees) {
    const parts = a.name.toLowerCase().trim().split(/\s+/);
    const attendeeLast = parts[parts.length - 1];
    if (attendeeLast === speaker && speaker.length > 2) return a;
  }

  return null;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Resolve a relative date hint (e.g., "by Friday", "next week") to an ISO date string.
 * Uses UTC throughout to avoid timezone-dependent date shifts.
 * Returns null if the hint can't be parsed.
 */
export function resolveDueDate(hint: string | null, meetingDate: string): string | null {
  if (!hint) return null;

  const h = hint.toLowerCase().trim();
  const base = new Date(meetingDate);
  if (isNaN(base.getTime())) return null;

  // "today"
  if (h === "today") {
    return toISODate(base);
  }

  // "tomorrow"
  if (h === "tomorrow") {
    base.setUTCDate(base.getUTCDate() + 1);
    return toISODate(base);
  }

  // Day names: "friday", "by friday", "this friday", "on monday"
  const dayMatch = h.match(/(?:by |this |on |next )?(\w+day)/);
  if (dayMatch) {
    const targetDay = DAY_NAMES.indexOf(dayMatch[1]);
    if (targetDay >= 0) {
      const isNext = h.includes("next");
      const currentDay = base.getUTCDay();
      let daysAhead = (targetDay - currentDay + 7) % 7;
      if (daysAhead === 0) daysAhead = 7; // same day = next week
      if (isNext) daysAhead += 7;
      base.setUTCDate(base.getUTCDate() + daysAhead);
      return toISODate(base);
    }
  }

  // "next week" → Monday of next week
  if (h.includes("next week")) {
    const currentDay = base.getUTCDay();
    const daysUntilMonday = (8 - currentDay) % 7 || 7;
    base.setUTCDate(base.getUTCDate() + daysUntilMonday);
    return toISODate(base);
  }

  // "end of week" / "this week" → Friday of the same week (or today if already Friday)
  if (h.includes("end of week") || h === "this week") {
    const currentDay = base.getUTCDay();
    const daysUntilFriday = (5 - currentDay + 7) % 7;
    if (daysUntilFriday === 0) return toISODate(base); // already Friday
    base.setUTCDate(base.getUTCDate() + daysUntilFriday);
    return toISODate(base);
  }

  // "end of month" / "end of the month"
  if (h.includes("end of") && h.includes("month")) {
    base.setUTCMonth(base.getUTCMonth() + 1, 0); // last day of current month
    return toISODate(base);
  }

  // "next month"
  if (h.includes("next month")) {
    base.setUTCMonth(base.getUTCMonth() + 1, 1);
    return toISODate(base);
  }

  // "in X days/weeks"
  const inMatch = h.match(/in (\d+)\s*(day|week|month)s?/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2];
    if (unit === "day") base.setUTCDate(base.getUTCDate() + n);
    else if (unit === "week") base.setUTCDate(base.getUTCDate() + n * 7);
    else if (unit === "month") base.setUTCMonth(base.getUTCMonth() + n);
    return toISODate(base);
  }

  return null;
}

function toISODate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
