/**
 * CAR-206 primitives. Everything here is about one property: a value that means
 * a calendar day, or a wall clock, must read the same on every machine.
 *
 * Zones are pinned per case with `process.env.TZ` rather than by an ambient
 * `TZ=` run, because these defects are asymmetric — some only appear west of
 * UTC, some only east, and two only at offsets that are not a whole hour.
 *
 * Every assertion was falsified against the implementation it guards before
 * being kept. Two earlier drafts of tests in this family passed against the
 * broken code (an eastward probe zone for the UTC pin, a shift-invariant run for
 * the streak), so "it went red" is the bar, not "it looks right".
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  dateKeyOf,
  daysBetweenDateKeys,
  formatDateKey,
  formatWallClock,
  isDateKey,
  localMidnightIso,
  shiftDateKey,
  toDateKey,
  todayDateKey,
  wallClockParts,
} from "@/lib/calendar-day";

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  return fn();
}

/** Whole-hour, half-hour, quarter-hour and midnight-DST offsets. */
const ZONES = [
  "UTC",
  "America/Denver",
  "America/Los_Angeles",
  "Pacific/Auckland",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Pacific/Chatham",
];

describe("isDateKey", () => {
  it("accepts real dates", () => {
    expect(isDateKey("2026-01-05")).toBe(true);
    expect(isDateKey("2024-02-29")).toBe(true); // leap year
  });

  it("rejects shapes that match the pattern but are not dates", () => {
    // A bare regex admits these. Letting them through made two functions in this
    // module disagree: the comparison helpers read the key as text while the
    // formatter rolled it over into some other day.
    expect(isDateKey("2026-13-45")).toBe(false);
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2023-02-29")).toBe(false); // not a leap year
    expect(isDateKey("2026-00-10")).toBe(false);
    expect(isDateKey("2026-1-5")).toBe(false);
    expect(isDateKey("garbage")).toBe(false);
  });

  it("does not silently remap a year below 0100 into the 1900s", () => {
    // Date.UTC applies the ECMA-262 legacy two-digit-year rule, so a naive
    // implementation turns year 50 into 1950 and then fails its own round trip.
    expect(isDateKey("0050-01-05")).toBe(true);
    expect(formatDateKey("0050-01-05", { year: "numeric" }, "en-US")).toBe("50");
    expect(shiftDateKey("0050-01-05", 1)).toBe("0050-01-06");
  });
});

describe("toDateKey", () => {
  it("takes the date part of a stored value, in every zone", () => {
    for (const tz of ZONES) {
      expect(inZone(tz, () => toDateKey("2026-01-05T00:00:00+00:00"))).toBe("2026-01-05");
    }
  });

  it("is null for absent or invalid input", () => {
    expect(toDateKey(null)).toBeNull();
    expect(toDateKey(undefined)).toBeNull();
    expect(toDateKey("")).toBeNull();
    expect(toDateKey("2026-02-30T00:00:00Z")).toBeNull();
  });
});

describe("dateKeyOf", () => {
  it("reads the viewer's local day off an instant, not the UTC one", () => {
    const instant = new Date("2026-01-05T23:00:00Z");
    expect(inZone("UTC", () => dateKeyOf(instant))).toBe("2026-01-05");
    expect(inZone("America/Denver", () => dateKeyOf(instant))).toBe("2026-01-05");
    expect(inZone("Pacific/Auckland", () => dateKeyOf(instant))).toBe("2026-01-06");
    expect(inZone("Asia/Kathmandu", () => dateKeyOf(instant))).toBe("2026-01-06");
  });

  it("is what todayDateKey returns for now", () => {
    const now = new Date("2026-01-05T18:00:00-07:00");
    expect(inZone("America/Denver", () => todayDateKey(now))).toBe(
      inZone("America/Denver", () => dateKeyOf(now)),
    );
  });
});

describe("shiftDateKey", () => {
  it("crosses month, year and leap boundaries", () => {
    expect(shiftDateKey("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("is unaffected by a DST transition in the viewer's zone", () => {
    // Zones that transition AT midnight, where the local day is 25 hours long
    // and `localMidnight + days * 86_400_000` lands back on the SAME date. US
    // zones transition at 02:00 and cannot catch this.
    for (const [tz, from, to] of [
      ["America/Santiago", "2026-04-04", "2026-04-05"],
      ["America/Havana", "2026-11-01", "2026-11-02"],
      ["Asia/Beirut", "2026-10-24", "2026-10-25"],
      ["Pacific/Chatham", "2026-04-05", "2026-04-06"],
    ] as const) {
      expect(inZone(tz, () => shiftDateKey(from, 1))).toBe(to);
    }
  });

  it("returns the input unchanged when it is not a date key", () => {
    expect(shiftDateKey("garbage", 1)).toBe("garbage");
  });
});

describe("daysBetweenDateKeys", () => {
  it("counts whole calendar days in both directions", () => {
    expect(daysBetweenDateKeys("2026-03-31", "2026-04-10")).toBe(10);
    expect(daysBetweenDateKeys("2026-04-10", "2026-03-31")).toBe(-10);
    expect(daysBetweenDateKeys("2026-04-10", "2026-04-10")).toBe(0);
  });

  it("is identical in every zone, including half- and quarter-hour offsets", () => {
    // The elapsed-millisecond form this replaced divided a gap between a LOCAL
    // midnight and a raw instant, so it came out one short at +05:30 and +05:45.
    for (const tz of ZONES) {
      expect(inZone(tz, () => daysBetweenDateKeys("2026-03-31", "2026-04-10"))).toBe(10);
    }
  });

  it("is unaffected by a DST transition inside the span", () => {
    for (const tz of ["America/Denver", "America/Santiago", "Pacific/Chatham"]) {
      expect(inZone(tz, () => daysBetweenDateKeys("2026-03-01", "2026-04-01"))).toBe(31);
    }
  });

  it("is 0 when either end is unparseable", () => {
    expect(daysBetweenDateKeys("nope", "2026-04-10")).toBe(0);
    expect(daysBetweenDateKeys("2026-04-10", "nope")).toBe(0);
  });
});

describe("localMidnightIso", () => {
  it("is strictly in the future whenever the key is after today", () => {
    // This is the invariant the home-page snooze depends on. Writing the STORED
    // midnight-UTC value instead produced a timestamp already in the past west
    // of UTC, so the snooze silently no-opped.
    for (const tz of ZONES) {
      const written = inZone(tz, () => {
        const now = new Date();
        const tomorrow = shiftDateKey(todayDateKey(now), 1);
        return { at: new Date(localMidnightIso(tomorrow)).getTime(), now: now.getTime() };
      });
      expect(written.at).toBeGreaterThan(written.now);
    }
  });

  it("is the local start of that date, not the UTC one", () => {
    expect(inZone("America/Denver", () => localMidnightIso("2026-07-26"))).toBe(
      "2026-07-26T06:00:00.000Z",
    );
    expect(inZone("UTC", () => localMidnightIso("2026-07-26"))).toBe("2026-07-26T00:00:00.000Z");
  });

  it("is empty for an unparseable key", () => {
    expect(localMidnightIso("2026-02-30")).toBe("");
  });
});

describe("wall-clock values (meetings.meeting_date)", () => {
  /** What Postgres stores for the naive string "2026-01-05T14:00" the form wrote. */
  const STORED = "2026-01-05T14:00:00+00:00";

  it("renders the digits the author typed, in every zone", () => {
    for (const tz of ZONES) {
      expect(
        inZone(tz, () =>
          formatWallClock(STORED, { month: "short", day: "numeric", year: "numeric" }, "en-US"),
        ),
      ).toBe("Jan 5, 2026");
      expect(
        inZone(tz, () => formatWallClock(STORED, { hour: "numeric", minute: "2-digit" }, "en-US")),
      ).toBe("2:00 PM");
    }
  });

  it("seeds an edit form with those same digits, in every zone", () => {
    // Local getters here re-seeded the form with the author's time shifted by the
    // viewer's offset, and saving persisted the shift — so every open-and-save
    // walked a meeting backward, compounding each time.
    for (const tz of ZONES) {
      expect(inZone(tz, () => wallClockParts(STORED))).toEqual({
        dateKey: "2026-01-05",
        time: "14:00",
      });
    }
  });

  it("round-trips: what the form writes is what the form reads back", () => {
    for (const tz of ZONES) {
      const parts = inZone(tz, () => wallClockParts(STORED))!;
      // The write path concatenates exactly these two fields, with no offset.
      const rewritten = `${parts.dateKey}T${parts.time}`;
      expect(rewritten).toBe("2026-01-05T14:00");
    }
  });

  it("is empty/null for absent or invalid input", () => {
    expect(formatWallClock(null)).toBe("");
    expect(formatWallClock("garbage")).toBe("");
    expect(wallClockParts(null)).toBeNull();
    expect(wallClockParts("garbage")).toBeNull();
  });
});
