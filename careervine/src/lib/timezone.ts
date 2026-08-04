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
 * The primary IANA zone ids this runtime knows, or null if it cannot say.
 *
 * Built lazily rather than at module load: this module is in the client bundle
 * (`api-client` imports TIMEZONE_HEADER from it), and `Intl.supportedValuesOf`
 * is ES2022 — absent in Safari below 15.4. Touching it at import time would
 * throw on load for those browsers; behind a lazy feature check it simply
 * degrades. In practice validation only runs server-side (`user-timezone` and
 * `api-handler` are the only callers), so the degraded path is a safety net.
 */
let primaryZones: Set<string> | null | undefined;
function knownPrimaryZones(): Set<string> | null {
  if (primaryZones !== undefined) return primaryZones;
  primaryZones =
    typeof Intl.supportedValuesOf === "function"
      ? new Set(Intl.supportedValuesOf("timeZone"))
      : null;
  return primaryZones;
}

/**
 * The canonical IANA id for an untrusted zone string, or null if unusable.
 *
 * ── Why "does Intl accept it?" is not enough (CAR-220) ───────────────────
 *
 * ECMA-402 also accepts fixed-offset pseudo-zones — verified accepted by the
 * old check: "+05:30", "-07:00", "+0530", "Etc/GMT+5". A fixed offset never
 * observes a DST transition, so persisting one into `users.timezone` puts back
 * exactly the bug this module exists to end: a value that looks like zone data
 * but silently never shifts. A browser populates the header from
 * `resolvedOptions().timeZone`, which yields a zone id rather than an offset
 * form, so the practical trigger is a hand-crafted `X-CV-Timezone` header.
 *
 * ── Why membership alone is not enough either ────────────────────────────
 *
 * `supportedValuesOf("timeZone")` lists only PRIMARY ids. Verified on this
 * runtime: it has no `UTC` entry and no `Etc/*` at all, and it omits
 * Asia/Kolkata, Asia/Kathmandu and Europe/Kyiv while carrying their canonical
 * targets. A bare membership test would therefore reject both the module's own
 * fallback and real zones a browser reports. So the value is canonicalized
 * first (`resolvedOptions().timeZone` resolves links and fixes casing), and
 * membership is tested on the canonical form.
 *
 * The canonical id is what gets RETURNED, so callers persist and forward a
 * spelling the tz database actually carries rather than whatever the header
 * said — which matters downstream, where the stored value is handed to Google's
 * freebusy API as a zone name.
 */
function canonicalTimeZone(value: unknown): string | null {
  // Length check first, so attacker-sized text never reaches Intl at all.
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;

  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }

  // UTC is a fixed offset, but it is this module's documented fallback and its
  // absence from the primary list would otherwise reject it. Every spelling
  // (UTC, Etc/UTC, GMT, Zulu, Universal) canonicalizes here, so they all
  // normalize to one stored value.
  if (canonical === "UTC" || canonical === "Etc/UTC") return FALLBACK_TIME_ZONE;

  const known = knownPrimaryZones();
  if (known) return known.has(canonical) ? canonical : null;

  // Runtime too old for supportedValuesOf: fall back to rejecting the offset
  // forms by shape. Offset zones canonicalize to a leading + or -, and the
  // fixed-offset Etc zones keep their Etc/GMT prefix.
  return /^[+-]/.test(canonical) || canonical.startsWith("Etc/GMT") ? null : canonical;
}

/**
 * True when `value` is a real, rule-bearing IANA zone (or UTC).
 *
 * The header is attacker-controlled and the value is persisted and later fed to
 * `Intl`, so it is validated before it is stored rather than trusted. See
 * `canonicalTimeZone` for why this is stricter than "does Intl accept it?".
 */
export function isValidIanaTimeZone(value: unknown): value is string {
  return canonicalTimeZone(value) !== null;
}

/**
 * Normalize an untrusted zone to its canonical id, or null if unusable.
 *
 * Returns the CANONICAL spelling, not the input: `US/Mountain` and
 * `america/denver` both come back as `America/Denver`.
 */
export function coerceTimeZone(value: unknown): string | null {
  return canonicalTimeZone(value);
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
 * ── Wall clocks that really exist ────────────────────────────────────────
 *
 * Always exact. Census over all 418 `Intl.supportedValuesOf("timeZone")`
 * entries across every transition 2025-2032, sampling both sides of each:
 * zero round-trip failures. Half-hour, 45-minute (Kathmandu, Eucla, Chatham)
 * and 30-minute-DST (Lord Howe) zones included.
 *
 * ── DST edge cases: deterministic, but NOT the same everywhere ───────────
 *
 * A previous version of this comment claimed the gap always resolves pre-jump
 * and the overlap always to the first occurrence. That was generalized from a
 * correct America/Denver spot-check and is false for most of the world. Which
 * side you land on follows the SIGN of the lower (non-advanced) of the two
 * offsets straddling the transition:
 *
 *   - Negative (the Americas): gap resolves to the PRE-jump side, and the
 *     overlap to the FIRST occurrence. Denver asked for 02:30 on 2026-03-08
 *     gives 01:30 MST.
 *   - Zero or positive (Europe, Africa, Asia, Oceania): gap resolves to the
 *     POST-jump side, and the overlap to the SECOND occurrence. London asked
 *     for 01:26 on 2026-03-29 gives 02:26 BST; Sydney asked for 02:26 on
 *     2026-04-05 gives the later of the two 02:26s.
 *
 * Measured, not assumed: probing every minute inside every gap and overlap for
 * all 418 zones over 2025-2032 (123,318 probes) splits 57 zones pre-jump/first
 * against 73 post-jump/second, with zero violations of that sign rule and no
 * zone in both buckets. Atlantic/Azores is why the rule names the LOWER offset
 * rather than "the zone's offset": it straddles -01:00 -> +00:00, and follows
 * the negative side.
 *
 * It never throws, and a request inside the gap never silently drifts an hour
 * from a caller's intent by more than the gap itself. One further consequence:
 * where the transition sits at local midnight, a gap request can come back on
 * the PREVIOUS calendar day — America/Havana asked for 00:30 on 2026-03-08
 * gives 2026-03-07 23:30. Havana, Santiago and Azores are the complete set of
 * zones where that happens over 2025-2032.
 *
 * None of this arises for the 9:05 AM default, since no zone transitions then,
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

  // First correction. The offset is measured at `guess`, which is the wall-clock
  // digits read as if they were UTC — a point that can sit on either side of a
  // nearby transition, so this offset is a starting estimate, not the answer.
  const firstOffset = zoneOffsetMsAt(guess, zone);
  const corrected = guess - firstOffset;

  // Re-measure at the corrected instant. If the correction crossed a transition,
  // `firstOffset` was the wrong side of it and this is the right one; if it did
  // not, this measures the same offset again and the result is unchanged. Both
  // cases are therefore just `guess - secondOffset` — no branch needed, since
  // when the offsets are equal `corrected` already IS `guess - secondOffset`.
  // One extra pass is enough because zone offsets are piecewise-constant and
  // transitions are far apart relative to a single shift; the 2025-2032 census
  // above found no wall clock that needed a third.
  const secondOffset = zoneOffsetMsAt(corrected, zone);
  return new Date(guess - secondOffset);
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
