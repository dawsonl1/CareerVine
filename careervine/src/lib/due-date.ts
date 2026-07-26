/**
 * Action-item due dates (CAR-206).
 *
 * `follow_up_action_items.due_at` is a `timestamptz`, but it is semantically a
 * CALENDAR DATE: every writer sends a bare `YYYY-MM-DD`, and every edit form
 * reads it back with a date-part split to seed the `DatePicker`. With the
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
 * "Jan 4, 2026". The formatter is the fix, not a workaround for a column type,
 * and a `date` column would reach it as the same `YYYY-MM-DD` anyway. What the
 * column change WOULD have bought — no real time-of-day ever landing in there —
 * is bought instead by `normalizeDueDate` on the interactive write paths and
 * `coerceDueDate` on the batch one.
 *
 * `isDueDateOverdue` is the one definition of overdue: the due date is strictly
 * before the LOCAL calendar today. An item due today is due, not overdue.
 * Before this module, two surfaces compared instants instead and rendered
 * today's items red from local midnight onward, disagreeing with the two that
 * did not.
 *
 * The zone-safe primitives underneath live in `calendar-day.ts`, shared with the
 * relationship rules; read that header for why day arithmetic never runs on a
 * local midnight.
 */

import {
  dateKeyOf,
  daysBetweenDateKeys,
  formatDateKey,
  shiftDateKey as shiftKey,
  todayDateKey as todayKey,
  toDateKey,
} from "./calendar-day";

export { dateKeyOf, daysBetweenDateKeys };

/**
 * The calendar date a `due_at` value denotes, as `YYYY-MM-DD`, or null when
 * there is no usable date. Round-trip validated, so `2026-02-30` reads as
 * absent rather than silently rolling over to March 2 on the way to the screen.
 */
export function dueDateKey(value: string | null | undefined): string | null {
  return toDateKey(value);
}

/**
 * Render a due date without letting the viewer's timezone move it.
 *
 * `options` and `locale` mirror `toLocaleDateString`, so a call site keeps the
 * exact format it had; `timeZone` is pinned to UTC and a caller-supplied one is
 * overridden on purpose (see `formatDateKey`). Returns "" when there is no due
 * date.
 */
export function formatDueDate(
  value: string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  return formatDateKey(dueDateKey(value), options, locale);
}

/** Today's LOCAL calendar date as `YYYY-MM-DD`. Never `toISOString()`. */
export function todayDateKey(now: Date = new Date()): string {
  return todayKey(now);
}

/** Move a date key by whole days, immune to DST in the viewer's zone. */
export function shiftDateKey(key: string, days: number): string {
  return shiftKey(key, days);
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

/**
 * Coerce a caller-supplied due date to the calendar date the column means, or
 * null to clear it. Returns null (rather than throwing) for anything
 * unparseable, so a batch writer can drop one bad cell instead of failing a
 * whole import.
 */
export function coerceDueDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  return dueDateKey(value);
}

/**
 * The strict form, for interactive writers: an explicit `null` clears the due
 * date, a usable date is normalised to its key, and anything else throws.
 *
 * Throwing is the point, and the empty string is the case that motivated it.
 * `""` used to reach PostgREST and fail with a 22007, so the update was refused
 * and nothing was lost. Mapping it to null instead would turn that loud,
 * harmless failure into silent erasure of a due date the caller was trying to
 * set — which is exactly the failure this function exists to prevent. Only an
 * explicit `null` means "clear it".
 */
export function normalizeDueDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const key = dueDateKey(value);
  if (key === null) {
    throw new Error(`Invalid due date ${JSON.stringify(value)} — expected a date like 2026-01-05`);
  }
  return key;
}
