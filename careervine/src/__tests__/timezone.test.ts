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
import { describe, it, expect } from "vitest";
import {
  isValidIanaTimeZone,
  coerceTimeZone,
  zonedWallClockToUtc,
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

  it("rejects junk, wrong types, and oversized values", () => {
    for (const bad of ["", "Mars/Olympus_Mons", "not a zone", "../../etc/passwd", null, undefined, 42, {}]) {
      expect(isValidIanaTimeZone(bad), String(bad)).toBe(false);
    }
    // The header is attacker-controlled; a megabyte of text must not reach Intl.
    expect(isValidIanaTimeZone("A".repeat(65))).toBe(false);
  });

  it("coerceTimeZone passes valid zones through and nulls the rest", () => {
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

  it("round-trips midnight, where hour12:false can render '24'", () => {
    const instant = zonedWallClockToUtc(2026, 11, 15, 0, 0, "America/Denver");
    expect(wallClockIn(instant, "America/Denver")).toBe("2026-11-15, 00:00");
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
