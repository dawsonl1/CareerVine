/**
 * Calendar-date handling for action-item due dates (CAR-206).
 *
 * `follow_up_action_items.due_at` is a `timestamptz`, but it is semantically a
 * CALENDAR DATE: every writer writes a bare `YYYY-MM-DD`, and every edit form
 * reads it back with `.split("T")[0]` to seed the `DatePicker`. With the
 * database session timezone at UTC (verified against the full migration chain),
 * Postgres stores `'2026-01-05'` as `2026-01-05 00:00:00+00` and PostgREST
 * returns `"2026-01-05T00:00:00+00:00"`, so the date part of the wire value is
 * exactly the date the user picked. That is the invariant this module owns.
 *
 * Two things went wrong before it existed, and both are easy to reintroduce:
 *
 * 1. `new Date(due_at).toLocaleDateString()` reinterprets midnight UTC through
 *    the viewer's zone, so every user west of UTC saw every due date one day
 *    early — while the edit modal, parsing the same value as local midnight,
 *    showed the right one. The app contradicted itself on screen.
 * 2. "Today" derived from `new Date().toISOString()` is the UTC calendar date,
 *    not the local one. West of UTC it rolls over mid-evening (17:00 Mountain),
 *    flipping everything due today to Overdue; east of UTC it lags all morning,
 *    so genuinely overdue items are not flagged at all.
 *
 * The column type was deliberately left as `timestamptz`. Switching it to
 * `date` fixes neither bug on its own: ECMA-262 parses a bare date-only string
 * as UTC, so `new Date("2026-01-05").toLocaleDateString()` in Denver is still
 * "Jan 4, 2026". The formatter here is the fix, not a workaround for a column
 * type, and a `date` column would reach it as the same `YYYY-MM-DD` anyway.
 *
 * Formatting deliberately builds the instant with `Date.UTC` and renders it
 * with `timeZone: "UTC"`, rather than parsing `value + "T00:00:00"` as local
 * midnight. Both read correctly today, but only the first is immune to zones
 * where local midnight does not exist on a given day (Pacific/Apia skipped
 * 2011-12-30 outright), where a local-midnight parse lands on the next date.
 *
 * `isDueDateOverdue` is the one definition of overdue: the due date is strictly
 * before the LOCAL calendar today. An item due today is due, not overdue.
 * Before this module, two surfaces compared instants instead and rendered
 * today's items red from local midnight onward, disagreeing with the two that
 * did not.
 *
 * Scope note: application deadlines have their own, already-correct helpers in
 * `application-date-value.ts` and `company-next-action.ts`. They are a
 * different domain concept and are intentionally not routed through here.
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The calendar date a `due_at` value denotes, as `YYYY-MM-DD`.
 *
 * Accepts what the wire actually carries (`2026-01-05T00:00:00+00:00`) as well
 * as a bare `2026-01-05` that never reached the database yet. Returns null for
 * null/empty input and for anything that is not a date key, so a malformed
 * value renders as absent rather than as `NaN`/`Invalid Date`.
 */
export function dueDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.split("T")[0];
  return DATE_KEY_RE.test(key) ? key : null;
}

/**
 * Render a due date without letting the viewer's timezone move it.
 *
 * `options` and `locale` mirror `toLocaleDateString`, so a call site keeps the
 * exact format it had; `timeZone` is fixed to UTC and cannot be overridden,
 * because that pin is the whole point. Returns "" when there is no due date.
 */
export function formatDueDate(
  value: string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  const key = dueDateKey(value);
  if (!key) return "";
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    ...options,
    timeZone: "UTC",
  });
}

/** Today's LOCAL calendar date as `YYYY-MM-DD`. Never `toISOString()`. */
export function todayDateKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Move a date key by whole days. Arithmetic runs in UTC so a DST transition in
 * the viewer's zone cannot add or drop a day.
 */
export function shiftDateKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Strictly before today, in the viewer's local calendar. Due today is not overdue. */
export function isDueDateOverdue(value: string | null | undefined, now: Date = new Date()): boolean {
  const key = dueDateKey(value);
  return key !== null && key < todayDateKey(now);
}

/** Due on or before `boundaryKey`. False when there is no due date. */
export function isDueDateOnOrBefore(value: string | null | undefined, boundaryKey: string): boolean {
  const key = dueDateKey(value);
  return key !== null && key <= boundaryKey;
}

/**
 * The end of the current week as a local date key: the upcoming Sunday, or a
 * week out when today is already Sunday. Preserves the grouping the action-item
 * list has always used, minus the local-to-UTC round trip that stretched the
 * bucket by a day west of UTC.
 */
export function endOfWeekDateKey(now: Date = new Date()): string {
  return shiftDateKey(todayDateKey(now), 7 - now.getDay());
}
