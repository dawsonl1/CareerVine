/**
 * IANA timezone handling (CAR-215).
 *
 * ── Why this module exists ───────────────────────────────────────────────
 *
 * Follow-up steps are supposed to land at 9:05 AM in the user's own morning.
 * The old implementation took `new Date().getTimezoneOffset()` from the browser
 * at the moment the sequence was CREATED and baked that fixed offset into every
 * future step's UTC timestamp. An offset is a snapshot, not a zone: a sequence
 * created in EDT (UTC-4) with a step landing after November's change fires at
 * 8:05 AM EST, an hour early. The 21-day step is the most exposed.
 *
 * A zone, unlike an offset, knows its own rules. So we store `America/Denver`
 * and resolve the offset *for the date the step actually lands on*.
 *
 * ── Why the conversion is hand-rolled ───────────────────────────────────
 *
 * There is no built-in "wall clock in zone Z -> UTC instant" in JS. `Intl` can
 * only go the other way (instant -> what the zone displays). `zonedWallClockToUtc`
 * inverts it by guessing, measuring the error, and correcting, with a second
 * pass because the offset at the corrected instant can differ from the offset at
 * the guess (that is exactly what a DST boundary is).
 */

/** Request header carrying the browser's IANA zone. Set in `api-client`. */
export const TIMEZONE_HEADER = "X-CV-Timezone";

/**
 * Last-resort zone when nothing is known about the user.
 *
 * Deliberately UTC and not a US zone. The bug this module fixes was a plausible
 * regional default (`America/New_York`) that was indistinguishable from real
 * data once written; UTC is obviously a fallback when someone reads it back.
 */
export const FALLBACK_TIME_ZONE = "UTC";

/**
 * True when `value` is a zone this runtime can actually resolve.
 *
 * The header is attacker-controlled (it is just a request header), and the value
 * is persisted and later fed to `Intl`, so it is validated before it is stored
 * rather than trusted. `Intl.DateTimeFormat` throws RangeError on an unknown
 * zone, which is the check: no allowlist to maintain, and it stays correct as
 * the platform's tz database is updated.
 */
export function isValidIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Normalize an untrusted zone to something safe to use, or null if unusable. */
export function coerceTimeZone(value: unknown): string | null {
  return isValidIanaTimeZone(value) ? value : null;
}

/**
 * The UTC offset (in ms) that `timeZone` is running at a given instant.
 *
 * Works by asking Intl what wall clock the zone displays at that instant, then
 * reading those digits back as if they were UTC. The difference between that
 * and the true instant is the offset.
 */
function zoneOffsetMsAt(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));

  const at = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };

  // `hour12: false` renders midnight as "24" in some ICU versions, which would
  // read back as the next day and put the offset out by 24h.
  const hour = at("hour") % 24;

  const wallClockAsUtc = Date.UTC(
    at("year"),
    at("month") - 1,
    at("day"),
    hour,
    at("minute"),
    at("second"),
  );
  return wallClockAsUtc - instantMs;
}

/**
 * The UTC instant at which `timeZone` shows the given local wall-clock time.
 *
 * DST edge cases, both deterministic and both pinned in timezone.test.ts
 * (verified empirically against America/Denver rather than assumed):
 *   - Spring-forward gap (a local time that never happens, e.g. 02:30 on the
 *     March transition): resolves to the corresponding instant on the PRE-jump
 *     side, so 02:30 becomes 01:30 MST. It does not throw and does not silently
 *     jump an hour forward.
 *   - Fall-back overlap (a local time that happens twice, e.g. 01:30 on the
 *     November transition): resolves to the FIRST occurrence, the one still on
 *     daylight time.
 * Neither arises for a 9:05 AM send in US zones, where transitions are at 2 AM,
 * but callers may pick any time and should not have to know that.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const zone = coerceTimeZone(timeZone) ?? FALLBACK_TIME_ZONE;
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // First correction, using the offset in force at the guessed instant.
  const firstOffset = zoneOffsetMsAt(guess, zone);
  const corrected = guess - firstOffset;

  // The correction may have moved us across a transition, in which case the
  // offset we used was the wrong side of it. Re-measure and redo from the
  // original guess; a second pass is provably enough because zone offsets are
  // piecewise-constant and transitions are far apart relative to one shift.
  const secondOffset = zoneOffsetMsAt(corrected, zone);
  return new Date(secondOffset === firstOffset ? corrected : guess - secondOffset);
}

/**
 * The HH:MM wall clock `timeZone` is showing at a given instant.
 *
 * Pairs with `zonedWallClockToUtc` to carry a time of day from one date to
 * another without carrying the offset that happened to apply on the first one.
 * The MCP follow-up path uses it to make new steps land at the same LOCAL hour
 * the opening email did, which survives a DST boundary in between; pinning the
 * UTC hour instead would silently shift the local hour by one across it.
 */
export function zonedTimeOfDay(instant: Date, timeZone: string): string {
  const zone = coerceTimeZone(timeZone) ?? FALLBACK_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const at = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = at("hour") % 24;
  return `${String(hour).padStart(2, "0")}:${String(at("minute")).padStart(2, "0")}`;
}

/** The calendar date `timeZone` is showing at a given instant. */
export function zonedDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const zone = coerceTimeZone(timeZone) ?? FALLBACK_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const at = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  return { year: at("year"), month: at("month"), day: at("day") };
}

/**
 * `dayOffset` calendar days after `from`, at `hour:minute` local to `timeZone`.
 *
 * Calendar arithmetic, not `+ n * 24h`: across a DST boundary a 24-hour step
 * lands on a different wall clock, and (at the far edges) a different local
 * date. Stepping the date fields keeps "7 days later at 9:05" literally true.
 */
export function localTimeDaysAfter(
  from: Date,
  dayOffset: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const { year, month, day } = zonedDateParts(from, timeZone);
  // Date.UTC normalizes overflow, so day + 21 rolls the month and year for us.
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return zonedWallClockToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    timeZone,
  );
}
