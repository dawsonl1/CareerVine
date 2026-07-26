/**
 * CAR-206: due dates are calendar dates and must not move with the viewer's
 * timezone, in either direction.
 *
 * Timezone is pinned by mutating `process.env.TZ` around each case rather than
 * by running the suite under a `TZ=` env var: the bug is asymmetric (west of
 * UTC over-reports overdue, east of UTC under-reports it), so a single ambient
 * zone can only ever catch one half of it. Node re-reads TZ per Date/Intl
 * operation, so the mutation takes effect immediately.
 *
 * Every assertion here was falsified against the pre-fix implementations
 * (`new Date(due_at).toLocaleDateString()` and `toISOString().split("T")[0]`)
 * before being kept.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  dueDateKey,
  formatDueDate,
  todayDateKey,
  shiftDateKey,
  isDueDateOverdue,
  isDueDateOnOrBefore,
  endOfWeekDateKey,
} from "@/lib/due-date";

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  return fn();
}

/** What PostgREST actually returns for a `due_at` written as "2026-01-05". */
const WIRE = "2026-01-05T00:00:00+00:00";

const WEST = ["America/Denver", "America/Los_Angeles"];
const ZONES = [...WEST, "UTC", "Pacific/Auckland"];

describe("dueDateKey", () => {
  it("reads the calendar date out of the wire value", () => {
    expect(dueDateKey(WIRE)).toBe("2026-01-05");
    expect(dueDateKey("2026-01-05T00:00:00Z")).toBe("2026-01-05");
    expect(dueDateKey("2026-01-05")).toBe("2026-01-05");
  });

  it("is the same date in every zone — it never parses through a clock", () => {
    for (const tz of ZONES) {
      expect(inZone(tz, () => dueDateKey(WIRE))).toBe("2026-01-05");
    }
  });

  it("returns null for absent or unparseable values rather than an Invalid Date", () => {
    expect(dueDateKey(null)).toBeNull();
    expect(dueDateKey(undefined)).toBeNull();
    expect(dueDateKey("")).toBeNull();
    expect(dueDateKey("not-a-date")).toBeNull();
    expect(dueDateKey("2026-1-5")).toBeNull();
  });
});

describe("formatDueDate", () => {
  it("renders the date the user picked in every zone (the ticket's core case)", () => {
    for (const tz of ZONES) {
      expect(
        inZone(tz, () => formatDueDate(WIRE, { month: "short", day: "numeric", year: "numeric" }, "en-US")),
      ).toBe("Jan 5, 2026");
    }
  });

  it("agrees with the DatePicker, which parses the same value as local midnight", () => {
    // The edit modal seeds `DatePicker` with dueDateKey(due_at) and the picker
    // displays `new Date(value + "T00:00:00")`. Card and modal must not
    // contradict each other on the same row — that contradiction was the bug.
    for (const tz of ZONES) {
      const card = inZone(tz, () =>
        formatDueDate(WIRE, { month: "short", day: "numeric", year: "numeric" }, "en-US"),
      );
      const picker = inZone(tz, () => {
        const key = dueDateKey(WIRE)!;
        return new Date(`${key}T00:00:00`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      });
      expect(card).toBe(picker);
    }
  });

  it("treats a bare date and the wire form identically", () => {
    for (const tz of ZONES) {
      expect(inZone(tz, () => formatDueDate("2026-01-05", undefined, "en-US"))).toBe(
        inZone(tz, () => formatDueDate(WIRE, undefined, "en-US")),
      );
    }
  });

  it("keeps each call site's format", () => {
    expect(formatDueDate(WIRE, { month: "long", day: "numeric", year: "numeric" }, "en-US")).toBe(
      "January 5, 2026",
    );
    expect(formatDueDate(WIRE, { month: "short", day: "numeric" }, "en-US")).toBe("Jan 5");
    expect(formatDueDate(WIRE, undefined, "en-US")).toBe("1/5/2026");
  });

  it("renders nothing when there is no due date", () => {
    expect(formatDueDate(null)).toBe("");
    expect(formatDueDate("garbage")).toBe("");
  });

  it("cannot be pushed off the date by a caller-supplied timeZone", () => {
    expect(
      formatDueDate(WIRE, { month: "short", day: "numeric", timeZone: "Pacific/Kiritimati" }, "en-US"),
    ).toBe("Jan 5");
  });
});

describe("todayDateKey", () => {
  it("is the LOCAL date at 18:00, not the UTC one it has already rolled into", () => {
    // 18:00 Denver on Jan 5 is 01:00 UTC on Jan 6. toISOString() said Jan 6,
    // which is what flipped every item due today to Overdue at 17:00 Mountain.
    const evening = new Date("2026-01-05T18:00:00-07:00");
    expect(inZone("America/Denver", () => todayDateKey(evening))).toBe("2026-01-05");
  });

  it("is the LOCAL date at 09:00 east of UTC, not the UTC one it has not reached", () => {
    // 09:00 Auckland on Jan 5 is 20:00 UTC on Jan 4. toISOString() said Jan 4,
    // so a genuinely overdue item read as still-due.
    const morning = new Date("2026-01-05T09:00:00+13:00");
    expect(inZone("Pacific/Auckland", () => todayDateKey(morning))).toBe("2026-01-05");
  });

  it("zero-pads single-digit months and days", () => {
    expect(inZone("UTC", () => todayDateKey(new Date("2026-03-07T12:00:00Z")))).toBe("2026-03-07");
  });
});

describe("isDueDateOverdue", () => {
  it("an item due today is NOT overdue at 18:00 local", () => {
    const evening = new Date("2026-01-05T18:00:00-07:00");
    expect(inZone("America/Denver", () => isDueDateOverdue(WIRE, evening))).toBe(false);
  });

  it("an item due today is NOT overdue at 09:00 local, in any zone", () => {
    for (const tz of ZONES) {
      // 09:00 local on Jan 5, expressed as the same wall clock in each zone.
      const morning = inZone(tz, () => new Date(2026, 0, 5, 9, 0, 0));
      expect(inZone(tz, () => isDueDateOverdue(WIRE, morning))).toBe(false);
    }
  });

  it("an item due yesterday IS overdue at 09:00 local, in any zone", () => {
    for (const tz of ZONES) {
      const morning = inZone(tz, () => new Date(2026, 0, 6, 9, 0, 0));
      expect(inZone(tz, () => isDueDateOverdue(WIRE, morning))).toBe(true);
    }
  });

  it("does not overcorrect east of UTC: an overdue item stays flagged all morning", () => {
    // The guard the ticket asked for. Under the old UTC "today" this read as
    // 2026-01-04 and the item due 2026-01-05 was not yet overdue on Jan 6.
    const morning = new Date("2026-01-06T09:00:00+13:00");
    expect(inZone("Pacific/Auckland", () => isDueDateOverdue(WIRE, morning))).toBe(true);
  });

  it("an item with no due date is never overdue", () => {
    expect(isDueDateOverdue(null)).toBe(false);
    expect(isDueDateOverdue("garbage")).toBe(false);
  });

  it("does not change verdict as the local clock crosses UTC midnight", () => {
    // Same local day, three times of day, one answer. This is the property the
    // whole ticket is about: nothing may reshuffle on the hour.
    const sameDay = ["09:00", "16:59", "18:00", "23:30"].map(
      (t) => new Date(`2026-01-05T${t}:00-07:00`),
    );
    const verdicts = sameDay.map((now) => inZone("America/Denver", () => isDueDateOverdue(WIRE, now)));
    expect(verdicts).toEqual([false, false, false, false]);
  });
});

describe("isDueDateOnOrBefore", () => {
  it("includes the boundary date and excludes the day after", () => {
    expect(isDueDateOnOrBefore(WIRE, "2026-01-05")).toBe(true);
    expect(isDueDateOnOrBefore(WIRE, "2026-01-06")).toBe(true);
    expect(isDueDateOnOrBefore(WIRE, "2026-01-04")).toBe(false);
  });

  it("is false when there is no due date", () => {
    expect(isDueDateOnOrBefore(null, "2026-01-05")).toBe(false);
  });
});

describe("shiftDateKey", () => {
  it("crosses month and year boundaries", () => {
    expect(shiftDateKey("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("is unaffected by a DST transition in the viewer's zone", () => {
    // 2026-03-08 is the US spring-forward. A local-midnight implementation
    // adding 24h of milliseconds lands on the same date, not the next one.
    for (const tz of WEST) {
      expect(inZone(tz, () => shiftDateKey("2026-03-07", 1))).toBe("2026-03-08");
      expect(inZone(tz, () => shiftDateKey("2026-03-08", 1))).toBe("2026-03-09");
    }
  });
});

describe("endOfWeekDateKey", () => {
  it("is the upcoming Sunday, as a local date with no UTC round trip", () => {
    // Monday 2026-01-05, 18:00 Denver. The old code built a local end-of-day
    // and converted it back through toISOString(), which stretched the "This
    // week" bucket to 2026-01-12 — a day into next week.
    const monday = new Date("2026-01-05T18:00:00-07:00");
    expect(inZone("America/Denver", () => endOfWeekDateKey(monday))).toBe("2026-01-11");
  });

  it("is a week out when today is already Sunday", () => {
    const sunday = new Date("2026-01-11T09:00:00-07:00");
    expect(inZone("America/Denver", () => endOfWeekDateKey(sunday))).toBe("2026-01-18");
  });

  it("lands on a Sunday from every day of the week", () => {
    for (let d = 5; d <= 11; d++) {
      const key = inZone("America/Denver", () =>
        endOfWeekDateKey(new Date(`2026-01-${String(d).padStart(2, "0")}T12:00:00-07:00`)),
      );
      const [y, m, day] = key.split("-").map(Number);
      expect(new Date(Date.UTC(y, m - 1, day)).getUTCDay()).toBe(0);
    }
  });
});
