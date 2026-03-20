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

/**
 * Check if the speaker name likely refers to the app user (self-reference).
 * These action items should be assigned to the contact being spoken to.
 */
export function isSelfReference(speakerName: string): boolean {
  const s = speakerName.toLowerCase().trim();
  return ["i", "me", "myself", "we", "us"].includes(s);
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Resolve a relative date hint (e.g., "by Friday", "next week") to an ISO date string.
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
    base.setDate(base.getDate() + 1);
    return toISODate(base);
  }

  // Day names: "friday", "by friday", "this friday", "on monday"
  const dayMatch = h.match(/(?:by |this |on |next )?(\w+day)/);
  if (dayMatch) {
    const targetDay = DAY_NAMES.indexOf(dayMatch[1]);
    if (targetDay >= 0) {
      const isNext = h.includes("next");
      const currentDay = base.getDay();
      let daysAhead = (targetDay - currentDay + 7) % 7;
      if (daysAhead === 0) daysAhead = 7; // same day = next week
      if (isNext) daysAhead += 7;
      base.setDate(base.getDate() + daysAhead);
      return toISODate(base);
    }
  }

  // "next week" → Monday of next week
  if (h.includes("next week")) {
    const currentDay = base.getDay();
    const daysUntilMonday = (8 - currentDay) % 7 || 7;
    base.setDate(base.getDate() + daysUntilMonday);
    return toISODate(base);
  }

  // "end of week" / "this week" → Friday of the same week
  if (h.includes("end of week") || h === "this week") {
    const currentDay = base.getDay();
    const daysUntilFriday = (5 - currentDay + 7) % 7 || 7;
    base.setDate(base.getDate() + daysUntilFriday);
    return toISODate(base);
  }

  // "end of month" / "end of the month"
  if (h.includes("end of") && h.includes("month")) {
    base.setMonth(base.getMonth() + 1, 0); // last day of current month
    return toISODate(base);
  }

  // "next month"
  if (h.includes("next month")) {
    base.setMonth(base.getMonth() + 1, 1);
    return toISODate(base);
  }

  // "in X days/weeks"
  const inMatch = h.match(/in (\d+)\s*(day|week|month)s?/);
  if (inMatch) {
    const n = parseInt(inMatch[1]);
    const unit = inMatch[2];
    if (unit === "day") base.setDate(base.getDate() + n);
    else if (unit === "week") base.setDate(base.getDate() + n * 7);
    else if (unit === "month") base.setMonth(base.getMonth() + n);
    return toISODate(base);
  }

  return null;
}

function toISODate(date: Date): string {
  return date.toISOString().split("T")[0];
}
