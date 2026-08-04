/**
 * CAR-215: the timezone helpers that replace the baked `getTimezoneOffset()`
 * snapshot in the follow-up scheduler.
 *
 * The bug being pinned: an offset captured at sequence-creation time is applied
 * to steps that land weeks later, so any step on the far side of a DST
 * transition fires an hour off. US transitions in 2026 are March 8 and
 * November 1, so a sequence created in October with a 21-day step is the
 * canonical failure.
 */
import { describe, it, expect, vi } from "vitest";
import {
  isValidIanaTimeZone,
  coerceTimeZone,
  zonedWallClockToUtc,
  zonedTimeOfDay,
  zonedDateParts,
  localTimeDaysAfter,
  FALLBACK_TIME_ZONE,
} from "@/lib/timezone";

/** What wall clock does `zone` show at this instant? Independent of the helper under test. */
function wallClockIn(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

describe("isValidIanaTimeZone", () => {
  it("accepts real zones", () => {
    for (const zone of ["America/Denver", "America/New_York", "Europe/London", "UTC", "Asia/Tokyo"]) {
      expect(isValidIanaTimeZone(zone), zone).toBe(true);
    }
  });

  it("rejects junk and wrong types", () => {
    for (const bad of ["", "Mars/Olympus_Mons", "not a zone", "../../etc/passwd", null, undefined, 42, {}]) {
      expect(isValidIanaTimeZone(bad), String(bad)).toBe(false);
    }
  });

  /**
   * The length cap is a SHORT-CIRCUIT, not a correctness filter. Intl rejects
   * "A".repeat(65) on its own, so the old `expect(...).toBe(false)` assertion
   * passed with the cap deleted and pinned nothing. Every >64-char probe tried
   * was rejected by Intl too (the longest primary zone id is 30 chars,
   * America/Argentina/Rio_Gallegos), so the cap is not observable through the
   * return value at all. What it actually buys is that attacker-sized text
   * never reaches Intl, so that is what this pins: deleting the cap makes the
   * constructor call count 1 and turns this red.
   */
  it("never hands an oversized value to Intl at all", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      expect(isValidIanaTimeZone("A".repeat(65))).toBe(false);
      expect(isValidIanaTimeZone("America/Denver".repeat(5000))).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Defect found in the CAR-220 review. ECMA-402 accepts fixed-offset zones and
   * legacy POSIX-style ids, so the old "does Intl.DateTimeFormat throw?" check
   * let them through. A fixed offset never observes a DST transition, which
   * reintroduces exactly the class of bug this module exists to end: a stored
   * value that looks like zone data but silently never shifts.
   */
  it("rejects fixed-offset pseudo-zones that Intl otherwise accepts", () => {
    for (const offsetZone of ["+05:30", "-07:00", "+0530", "-0700", "Etc/GMT+5", "Etc/GMT-5"]) {
      // Guard the premise: these really are accepted by the raw Intl check.
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: offsetZone }), offsetZone).not.toThrow();
      expect(isValidIanaTimeZone(offsetZone), offsetZone).toBe(false);
      expect(coerceTimeZone(offsetZone), offsetZone).toBeNull();
    }
  });

  /**
   * UTC is the module's own documented fallback, so it must keep validating —
   * even though it is technically a fixed offset. Note it is NOT a member of
   * `Intl.supportedValuesOf("timeZone")` (verified: that list carries no `Etc/*`
   * and no `UTC` entry), so a naive allowlist check would reject the fallback.
   */
  it("accepts UTC and its aliases, normalizing them all to the fallback spelling", () => {
    for (const utcish of ["UTC", "Etc/UTC", "GMT", "Etc/GMT", "Zulu", "Universal"]) {
      expect(isValidIanaTimeZone(utcish), utcish).toBe(true);
      expect(coerceTimeZone(utcish), utcish).toBe(FALLBACK_TIME_ZONE);
    }
  });

  /**
   * `supportedValuesOf` lists only PRIMARY zone ids, so a bare membership test
   * would reject real browser-reported zones that are links to a primary id.
   * Verified on this runtime: Asia/Kolkata, Asia/Kathmandu and Europe/Kyiv are
   * all absent from the list while their canonical targets are present. So the
   * check canonicalizes first, and the canonical form is what gets returned —
   * which also means downstream consumers (Google freebusy) get a zone name the
   * tz database actually carries.
   */
  it("accepts aliases and non-canonical spellings, returning the canonical id", () => {
    const supported = new Set(Intl.supportedValuesOf("timeZone"));
    // Stable, long-settled aliases: exact canonical target asserted.
    expect(coerceTimeZone("US/Mountain")).toBe("America/Denver");
    expect(coerceTimeZone("america/denver")).toBe("America/Denver");
    // EST5EDT is a POSIX-style id, but it is a link to a REAL DST-observing
    // zone rather than a frozen offset, so it is legitimately accepted.
    expect(coerceTimeZone("EST5EDT")).toBe("America/New_York");

    // These flip canonical target between ICU releases (Kolkata/Calcutta,
    // Kyiv/Kiev), so pin the property rather than the string.
    for (const alias of ["Asia/Kolkata", "Asia/Kathmandu", "Europe/Kyiv"]) {
      const canonical = coerceTimeZone(alias);
      expect(canonical, alias).not.toBeNull();
      expect(supported.has(canonical as string), `${alias} -> ${canonical} is canonical`).toBe(true);
    }
  });

  it("accepts real zones and coerceTimeZone nulls the rest", () => {
    expect(coerceTimeZone("America/Denver")).toBe("America/Denver");
    expect(coerceTimeZone("Mars/Olympus_Mons")).toBeNull();
  });
});

describe("zonedWallClockToUtc", () => {
  it("resolves a summer (DST) wall clock in Denver", () => {
    // 2026-10-15 is MDT, UTC-6.
    expect(zonedWallClockToUtc(2026, 10, 15, 9, 5, "America/Denver").toISOString())
      .toBe("2026-10-15T15:05:00.000Z");
  });

  it("resolves a winter (standard) wall clock in Denver", () => {
    // 2026-11-15 is MST, UTC-7.
    expect(zonedWallClockToUtc(2026, 11, 15, 9, 5, "America/Denver").toISOString())
      .toBe("2026-11-15T16:05:00.000Z");
  });

  it("resolves both sides of the Eastern transition", () => {
    expect(zonedWallClockToUtc(2026, 10, 15, 9, 5, "America/New_York").toISOString())
      .toBe("2026-10-15T13:05:00.000Z"); // EDT, UTC-4
    expect(zonedWallClockToUtc(2026, 11, 15, 9, 5, "America/New_York").toISOString())
      .toBe("2026-11-15T14:05:00.000Z"); // EST, UTC-5
  });

  it("round-trips midnight", () => {
    const instant = zonedWallClockToUtc(2026, 11, 15, 0, 0, "America/Denver");
    expect(wallClockIn(instant, "America/Denver")).toBe("2026-11-15, 00:00");
  });

  /**
   * The `% 24` guards exist for ICU builds where `hour12: false` resolves to
   * hourCycle h24 and renders midnight as hour "24". Current Node resolves it
   * to h23 (verified: `hour12:false` reports hourCycle "h23" and renders "00"),
   * so the plain midnight test above passes with both `% 24` guards deleted and
   * pins nothing. The quirk IS reproducible by forcing h24 — under it, ICU
   * renders hour "24" while keeping the CORRECT date, so reading it back
   * literally lands 24h out. This stub forces that build's behaviour so the
   * guard is actually exercised; deleting either `% 24` turns this red.
   */
  it("survives an ICU build that renders midnight as hour '24'", () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    const patched = function (locale?: string, options?: Intl.DateTimeFormatOptions) {
      const opts: Intl.DateTimeFormatOptions = { ...options };
      if (opts.hour12 === false) {
        delete opts.hour12;
        opts.hourCycle = "h24";
      }
      return new RealDateTimeFormat(locale, opts);
    } as unknown as typeof Intl.DateTimeFormat;
    patched.supportedLocalesOf = RealDateTimeFormat.supportedLocalesOf;
    Intl.DateTimeFormat = patched;

    try {
      // Premise guard: the stub really does produce hour "24" on the date we use.
      const raw = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver", hour12: false, hour: "2-digit",
      }).formatToParts(new Date("2026-11-15T07:00:00Z"));
      expect(raw.find((p) => p.type === "hour")?.value).toBe("24");

      // Denver is UTC-7 on 2026-11-15, so local midnight is 07:00Z.
      expect(zonedWallClockToUtc(2026, 11, 15, 0, 0, "America/Denver").toISOString())
        .toBe("2026-11-15T07:00:00.000Z");
      expect(zonedTimeOfDay(new Date("2026-11-15T07:00:00Z"), "America/Denver")).toBe("00:00");
    } finally {
      Intl.DateTimeFormat = RealDateTimeFormat;
    }
  });

  it("round-trips a sweep of times and zones back to the requested wall clock", () => {
    const zones = ["America/Denver", "America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Tokyo"];
    const dates: Array<[number, number, number]> = [
      [2026, 1, 15], [2026, 3, 8], [2026, 6, 30], [2026, 11, 1], [2026, 12, 31],
    ];
    for (const zone of zones) {
      for (const [y, m, d] of dates) {
        const instant = zonedWallClockToUtc(y, m, d, 9, 5, zone);
        const pad = (n: number) => String(n).padStart(2, "0");
        expect(wallClockIn(instant, zone), `${zone} ${y}-${m}-${d}`)
          .toBe(`${y}-${pad(m)}-${pad(d)}, 09:05`);
      }
    }
  });

  /**
   * Coverage note, established by deleting the second correction pass and
   * re-running: only the spring-forward gap case and the round-trip sweep go
   * red. The overlap case below and the "across the November transition" cases
   * further down pass either way, because there the guess and the corrected
   * instant sit on the same side of the boundary. So the gap test is the one
   * actually guarding the second pass; the overlap test pins which of the two
   * occurrences we pick, which is stable regardless.
   */
  it("resolves a spring-forward gap to the pre-jump side rather than throwing", () => {
    // 2026-03-08, Denver jumps 02:00 MST -> 03:00 MDT, so 02:30 never happens.
    const gap = zonedWallClockToUtc(2026, 3, 8, 2, 30, "America/Denver");
    expect(gap.toISOString()).toBe("2026-03-08T08:30:00.000Z");
    expect(wallClockIn(gap, "America/Denver")).toBe("2026-03-08, 01:30");

    // The first real instant after the jump is still exact.
    const after = zonedWallClockToUtc(2026, 3, 8, 3, 0, "America/Denver");
    expect(wallClockIn(after, "America/Denver")).toBe("2026-03-08, 03:00");
  });

  it("resolves a fall-back overlap to the first occurrence", () => {
    // 2026-11-01, Denver repeats 01:00-02:00; 01:30 happens at 07:30Z (MDT)
    // and again at 08:30Z (MST). We take the earlier one.
    const overlap = zonedWallClockToUtc(2026, 11, 1, 1, 30, "America/Denver");
    expect(overlap.toISOString()).toBe("2026-11-01T07:30:00.000Z");
    expect(wallClockIn(overlap, "America/Denver")).toBe("2026-11-01, 01:30");
  });

  /**
   * The other half of the gap/overlap behaviour, and the reason the old doc
   * comment was wrong. Denver's "pre-jump / first occurrence" result is not a
   * universal law: which side you land on follows the SIGN of the lower
   * (non-advanced) of the two offsets straddling the transition. These two
   * zones are non-negative, so they land on the opposite side from Denver.
   *
   * Census over all 418 `Intl.supportedValuesOf("timeZone")` entries, every
   * transition 2025-2032, probing every minute inside each gap/overlap
   * (123,318 probes): 57 zones pre-jump/first, 73 post-jump/second, and zero
   * violations of the sign rule. No zone appeared in both buckets.
   */
  it("resolves a spring-forward gap to the POST-jump side in a non-negative zone", () => {
    // 2026-03-29, London jumps 01:00 GMT (UTC+0) -> 02:00 BST (UTC+1).
    // 01:26 never happens; unlike Denver, it lands after the jump, not before.
    const gap = zonedWallClockToUtc(2026, 3, 29, 1, 26, "Europe/London");
    expect(gap.toISOString()).toBe("2026-03-29T01:26:00.000Z");
    expect(wallClockIn(gap, "Europe/London")).toBe("2026-03-29, 02:26");
  });

  it("resolves a fall-back overlap to the SECOND occurrence in a positive zone", () => {
    // 2026-04-05, Sydney repeats 02:00-03:00 (UTC+11 -> UTC+10). 02:26 happens
    // at 15:26Z and again at 16:26Z; unlike Denver, we get the later one.
    const overlap = zonedWallClockToUtc(2026, 4, 5, 2, 26, "Australia/Sydney");
    expect(overlap.toISOString()).toBe("2026-04-04T16:26:00.000Z");
    expect(wallClockIn(overlap, "Australia/Sydney")).toBe("2026-04-05, 02:26");
    // Pin that this really is the SECOND of two: the first also reads 02:26.
    expect(wallClockIn(new Date("2026-04-04T15:26:00.000Z"), "Australia/Sydney")).toBe("2026-04-05, 02:26");
  });

  /**
   * Atlantic/Azores is the zone that forces the rule to be stated in terms of
   * the LOWER offset rather than "the zone's offset": it straddles -01:00 ->
   * +00:00, so the two sides disagree in sign. It follows the negative side.
   */
  it("follows the lower offset's sign in a zone that straddles zero", () => {
    // 2026-03-29: Azores jumps 00:00 -01 -> 01:00 +00. Lower offset is -01:00,
    // so this behaves like Denver (pre-jump), not like London.
    const gap = zonedWallClockToUtc(2026, 3, 29, 0, 30, "Atlantic/Azores");
    expect(gap.getTime()).toBeLessThan(new Date("2026-03-29T01:00:00.000Z").getTime());
  });

  /**
   * A gap request can roll the LOCAL DATE back a day when the transition sits
   * at local midnight, which is a second way "resolves to the pre-jump side"
   * misleads. Verified across 2025-2032 as the complete set of zones where a
   * gap probe leaves the requested calendar day: Havana, Santiago, Azores.
   * Unreachable from the 09:05 default; reachable via a user-picked sendTime.
   */
  it("can roll the local date back for a midnight-transition zone", () => {
    const havana = zonedWallClockToUtc(2026, 3, 8, 0, 30, "America/Havana");
    expect(wallClockIn(havana, "America/Havana")).toBe("2026-03-07, 23:30");

    const santiago = zonedWallClockToUtc(2026, 9, 6, 0, 30, "America/Santiago");
    expect(wallClockIn(santiago, "America/Santiago")).toBe("2026-09-05, 23:30");
  });

  it("falls back to UTC for an unusable zone instead of throwing", () => {
    expect(zonedWallClockToUtc(2026, 11, 15, 9, 5, "Mars/Olympus_Mons").toISOString())
      .toBe("2026-11-15T09:05:00.000Z");
    expect(FALLBACK_TIME_ZONE).toBe("UTC");
  });
});

describe("zonedDateParts", () => {
  it("reports the local calendar date, not the UTC one", () => {
    // 03:30 UTC on Nov 16 is still 20:30 on Nov 15 in Denver.
    expect(zonedDateParts(new Date("2026-11-16T03:30:00Z"), "America/Denver"))
      .toEqual({ year: 2026, month: 11, day: 15 });
  });
});

describe("localTimeDaysAfter", () => {
  it("holds 9:05 local across the November DST transition (the CAR-215 bug)", () => {
    // Sequence created 2026-10-15 (MDT). The 21-day step lands 2026-11-05,
    // after the Nov 1 fall-back, so the zone has changed under it.
    const created = new Date("2026-10-15T15:05:00Z");
    const step = localTimeDaysAfter(created, 21, 9, 5, "America/Denver");

    expect(wallClockIn(step, "America/Denver")).toBe("2026-11-05, 09:05");
    expect(step.toISOString()).toBe("2026-11-05T16:05:00.000Z");

    // What the old offset-snapshot approach produced: creation-time offset was
    // MDT (360 min), so the step was written an hour early in local terms.
    const bakedOffsetMinutes = 360;
    const naive = new Date(created.getTime() + 21 * 24 * 60 * 60 * 1000);
    naive.setUTCHours(9, 5, 0, 0);
    naive.setUTCMinutes(naive.getUTCMinutes() + bakedOffsetMinutes);
    expect(naive.toISOString()).toBe("2026-11-05T15:05:00.000Z");
    expect(wallClockIn(naive, "America/Denver")).toBe("2026-11-05, 08:05");

    // The fix is exactly this hour.
    expect(step.getTime() - naive.getTime()).toBe(60 * 60 * 1000);
  });

  it("holds 9:05 local across the March DST transition", () => {
    // Created 2026-02-20 (MST); +21 days lands 2026-03-13, after the Mar 8
    // spring-forward.
    const step = localTimeDaysAfter(new Date("2026-02-20T16:05:00Z"), 21, 9, 5, "America/Denver");
    expect(wallClockIn(step, "America/Denver")).toBe("2026-03-13, 09:05");
    expect(step.toISOString()).toBe("2026-03-13T15:05:00.000Z");
  });

  it("uses calendar-day arithmetic, so it rolls months and years", () => {
    const step = localTimeDaysAfter(new Date("2026-12-20T17:05:00Z"), 21, 9, 5, "America/Denver");
    expect(wallClockIn(step, "America/Denver")).toBe("2027-01-10, 09:05");
  });

  it("steps from the LOCAL date, not the UTC date", () => {
    // 03:30 UTC Nov 16 is Nov 15 in Denver, so +7 days is Nov 22, not Nov 23.
    const step = localTimeDaysAfter(new Date("2026-11-16T03:30:00Z"), 7, 9, 5, "America/Denver");
    expect(wallClockIn(step, "America/Denver")).toBe("2026-11-22, 09:05");
  });

  it("gives every US zone the same local 9:05, not the same instant", () => {
    const created = new Date("2026-11-16T03:30:00Z");
    const zones = ["America/New_York", "America/Denver", "America/Los_Angeles"];
    const instants = zones.map((z) => localTimeDaysAfter(created, 7, 9, 5, z));
    for (const [i, zone] of zones.entries()) {
      expect(wallClockIn(instants[i], zone), zone).toMatch(/09:05$/);
    }
    // Eastern's 9:05 comes first; Pacific's is three hours later.
    expect(instants[2].getTime() - instants[0].getTime()).toBe(3 * 60 * 60 * 1000);
  });
});
