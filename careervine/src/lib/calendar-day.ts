/**
 * Zone-safe calendar-day primitives (CAR-206).
 *
 * Several columns in this schema are `timestamptz` but do not hold an instant.
 * They hold a CALENDAR DATE, or a naive local WALL CLOCK, that the client wrote
 * without an offset and Postgres (session TimeZone = UTC) then stored as UTC:
 *
 *   - `follow_up_action_items.due_at` — every writer sends `YYYY-MM-DD`, so the
 *     stored value is midnight UTC of the date the user picked.
 *   - `meetings.meeting_date` — every writer sends `YYYY-MM-DD` or
 *     `YYYY-MM-DDTHH:MM` with no offset, so the stored value is the wall clock
 *     the user typed, labelled UTC.
 *
 * Reading either of those back with `new Date(value)` and formatting in the
 * viewer's zone reinterprets a value that was never an instant, which is how
 * every user west of UTC ended up seeing dates one day early. Comparing them
 * against a `new Date()` "now" makes the same mistake in the other direction.
 *
 * This module is the one place that knows how to go between those stored values
 * and a calendar day. Two vocabularies:
 *
 *   DATE KEY — a `YYYY-MM-DD` string. Comparable with `<`, `>` and `===`
 *   directly (ISO dates sort lexicographically), so day logic never needs a Date
 *   at all. `dateKeyOf` reads one off an instant using the LOCAL calendar, which
 *   is the viewer's own day; `toDateKey` reads one off a stored value by taking
 *   the date part, which is what the writer meant.
 *
 *   WALL CLOCK — rendering a stored naive value by pinning `timeZone: "UTC"`,
 *   which reproduces exactly the digits the user typed, on any viewer's machine.
 *
 * All arithmetic runs on UTC instants built from the key, never on local
 * midnight, because local midnight is not a fixed thing: it does not exist at
 * all on some days (Pacific/Apia skipped 2011-12-30 outright) and a local day is
 * 23 or 25 hours long across a DST boundary, so `localMidnight + n * 86_400_000`
 * silently lands on the wrong date in every zone that transitions at midnight
 * (America/Santiago, America/Havana, Asia/Beirut, Pacific/Chatham).
 *
 * Domain semantics live one level up: `due-date.ts` for action-item due dates,
 * `rules/clock.ts` for the relationship rules. Application deadlines have their
 * own older helpers in `application-date-value.ts`, which are already correct.
 */

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");
/** Years pad to four digits, so a key stays a key below year 1000. */
const pad4 = (n: number) => String(n).padStart(4, "0");

/**
 * A UTC instant at midnight on the given calendar date.
 *
 * `Date.UTC` applies the ECMA-262 legacy rule that maps a year of 0-99 onto
 * 1900+year, so a date key of `0050-01-05` would silently become 1950. The
 * explicit `setUTCFullYear` undoes that, which matters because the comparison
 * helpers read the key as literal text: without this, two functions in this
 * module would disagree about which year the same key denotes.
 */
function utcInstantOf(year: number, month: number, day: number): Date {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (year >= 0 && year <= 99) d.setUTCFullYear(year);
  return d;
}

/**
 * Whether `value` is a real calendar date in `YYYY-MM-DD` form.
 *
 * Round-trip validated, not just regex-matched: `2026-13-45` and `2026-02-30`
 * match the shape but are not dates, and letting them through would make
 * formatting (which rolls them over into some other day) disagree with
 * comparison (which reads the text literally).
 */
export function isDateKey(value: string): boolean {
  const m = value.match(DATE_KEY_RE);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = utcInstantOf(year, month, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * The date key a stored value denotes: its date part, validated.
 *
 * Accepts what the wire carries (`2026-01-05T00:00:00+00:00`) and a bare
 * `2026-01-05` that has not reached the database yet. Returns null for absent
 * or unparseable input so a bad value reads as "no date" rather than as an
 * Invalid Date that formats to "NaN" and compares as neither `<` nor `>`.
 */
export function toDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const key = value.split("T")[0];
  return isDateKey(key) ? key : null;
}

/** The date key of an instant in the VIEWER'S local calendar. Never `toISOString()`. */
export function dateKeyOf(date: Date): string {
  return `${pad4(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today, in the viewer's local calendar. */
export function todayDateKey(now: Date = new Date()): string {
  return dateKeyOf(now);
}

/** Move a date key by whole days. UTC arithmetic, so no DST transition can add or drop one. */
export function shiftDateKey(key: string, days: number): string {
  const m = key.match(DATE_KEY_RE);
  if (!m) return key;
  const shifted = utcInstantOf(Number(m[1]), Number(m[2]), Number(m[3]) + days);
  return `${pad4(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Whole calendar days from `from` to `to`; negative when `to` is earlier.
 *
 * Both ends are UTC midnights, so the difference is an exact multiple of a day
 * and this is offset- and DST-independent. Returns 0 for an unparseable end.
 */
export function daysBetweenDateKeys(from: string, to: string): number {
  const a = from.match(DATE_KEY_RE);
  const b = to.match(DATE_KEY_RE);
  if (!a || !b) return 0;
  const start = utcInstantOf(Number(a[1]), Number(a[2]), Number(a[3]));
  const end = utcInstantOf(Number(b[1]), Number(b[2]), Number(b[3]));
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Render a date key without letting the viewer's zone move it.
 *
 * `options` and `locale` mirror `toLocaleDateString` so a call site keeps the
 * format it had. `timeZone` is forced to UTC and a caller-supplied one is
 * deliberately overridden, because the instant here is a synthetic UTC midnight
 * that stands for a calendar date: honouring any other zone would shift it off
 * that date, which is the entire bug this module exists to prevent.
 */
export function formatDateKey(
  key: string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  if (!key || !isDateKey(key)) return "";
  const [year, month, day] = key.split("-").map(Number);
  return utcInstantOf(year, month, day).toLocaleDateString(locale, { ...options, timeZone: "UTC" });
}

/**
 * The instant at LOCAL midnight starting the given date key, as an ISO string.
 *
 * For writing a real timestamp derived from a calendar decision — a snooze that
 * should last until a date arrives, say. The distinction matters: the stored
 * midnight-UTC value that DENOTES that date is not the same instant, and west of
 * UTC it has already elapsed by late afternoon, so reusing it as a deadline
 * produces something already in the past.
 *
 * Returns "" for an unparseable key.
 */
export function localMidnightIso(key: string): string {
  const m = key.match(DATE_KEY_RE);
  if (!m || !isDateKey(key)) return "";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toISOString();
}

/**
 * Split a stored naive wall-clock value back into the form fields that wrote it:
 * `{ dateKey: "2026-01-05", time: "14:00" }`.
 *
 * UTC getters, deliberately. Reading local ones off a value that was stored as a
 * naive wall clock re-seeds the edit form with the author's digits shifted by the
 * viewer's offset, and saving then persists the shifted value — so every
 * open-and-save walked a meeting backward by one offset, compounding each time.
 *
 * Returns null when there is nothing usable to seed from.
 */
export function wallClockParts(
  value: string | null | undefined,
): { dateKey: string; time: string } | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    dateKey: `${pad4(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/**
 * Render a stored naive wall-clock value as the digits the user typed.
 *
 * For columns like `meetings.meeting_date` that hold `YYYY-MM-DDTHH:MM` written
 * with no offset. Pinning UTC reproduces the author's input exactly; formatting
 * in the viewer's zone shifts it by their offset, which is why a meeting entered
 * as "Jan 5, 2:00 PM" displayed as "Jan 4, 7:00 AM" in Denver.
 *
 * This is NOT for genuine instants. `created_at`, `completed_at`,
 * `scheduled_send_at` and the Gmail/Calendar timestamps are real moments and
 * must keep rendering in the viewer's local zone.
 */
export function formatWallClock(
  value: string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { ...options, timeZone: "UTC" });
}
