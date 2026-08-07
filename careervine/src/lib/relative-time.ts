/**
 * Human relative time for UI chips (CAR-246).
 *
 * One function for both directions: the caller hands over a timestamp and the
 * sign of the difference decides between "2 weeks ago" and "in 2 weeks". The
 * companies-list chip needs exactly that — Call Scheduled points forward while
 * every other traction state points back, and making the card branch on which
 * one it holds would put calendar logic in a render path.
 *
 * Differences are measured in CALENDAR days from local midnight, not in
 * 24-hour spans, so a touch at 11pm yesterday reads "yesterday" rather than
 * "today" for the next hour. `now` is injectable so the ladder is testable
 * without freezing the clock, matching `deriveNextAction`'s convention.
 */

/** Whole calendar days from `now` to `then`; negative = in the past. */
function calendarDayDelta(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * The size of the gap, without direction: "3 days", "2 weeks", "1 month".
 *
 * Each rung is capped so it never renders a zero — 28 days is "1 month", not
 * "0 months" — which is what a bare `Math.floor` division produces at the
 * bottom of every band.
 */
function magnitude(days: number): string {
  if (days < 7) return plural(days, "day");
  if (days < 28) return plural(Math.floor(days / 7), "week");
  if (days < 365) return plural(Math.max(1, Math.floor(days / 30)), "month");
  return plural(Math.max(1, Math.floor(days / 365)), "year");
}

/**
 * "today" | "yesterday" | "3 days ago" | "2 weeks ago" | "in 3 days" | ...
 *
 * Returns null for a missing or unparseable timestamp, so callers can drop the
 * clause entirely rather than render a wrong or empty time.
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;

  const days = calendarDayDelta(then, now);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${magnitude(days)}` : `${magnitude(-days)} ago`;
}

/**
 * The same ladder for a moment that can only be in the past: "today" |
 * "yesterday" | "3 days ago" (CAR-253).
 *
 * A FUTURE timestamp returns null rather than "in 3 days". Callers here are
 * sentences about something that already happened — "You reached out …" — and
 * the dates behind them come from `Date:` headers and hand-entered interaction
 * dates, either of which can land in the future. A clause that has to read as
 * past tense is better dropped than rendered backwards.
 */
export function formatTimeAgo(iso: string | null | undefined, now: Date = new Date()): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;

  const days = calendarDayDelta(then, now);
  if (days > 0) return null;
  if (days === 0) return "today";
  if (days === -1) return "yesterday";
  return `${magnitude(-days)} ago`;
}
