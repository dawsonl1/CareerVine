/**
 * The relative-time ladder behind the traction chip (CAR-246).
 *
 * Two things are worth pinning rather than trusting: every band BOUNDARY, since
 * a bare `Math.floor` division renders "0 months" at the bottom of each one, and
 * the calendar-day rule, since measuring in 24-hour spans instead would call
 * something that happened at 11pm last night "today" for another hour.
 */

import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "@/lib/relative-time";

/** Local noon, so day arithmetic never straddles a DST shift. */
const NOW = new Date(2026, 7, 6, 12, 0, 0);

/** A local timestamp `days` from NOW, at the same hour. */
function offset(days: number): string {
  const d = new Date(2026, 7, 6 + days, 12, 0, 0);
  return d.toISOString();
}

describe("formatRelativeTime", () => {
  it("names the three days around today instead of counting them", () => {
    expect(formatRelativeTime(offset(0), NOW)).toBe("today");
    expect(formatRelativeTime(offset(-1), NOW)).toBe("yesterday");
    expect(formatRelativeTime(offset(1), NOW)).toBe("tomorrow");
  });

  it.each([
    [-2, "2 days ago"],
    [-6, "6 days ago"],
    [-7, "1 week ago"],
    [-13, "1 week ago"],
    [-14, "2 weeks ago"],
    [-27, "3 weeks ago"],
    [-28, "1 month ago"],
    [-59, "1 month ago"],
    [-60, "2 months ago"],
    [-364, "12 months ago"],
    [-365, "1 year ago"],
    [-730, "2 years ago"],
  ])("reads %i days out as %s", (days, expected) => {
    expect(formatRelativeTime(offset(days), NOW)).toBe(expected);
  });

  it.each([
    [2, "in 2 days"],
    [7, "in 1 week"],
    [21, "in 3 weeks"],
    [28, "in 1 month"],
    [365, "in 1 year"],
  ])("reads %i days ahead as %s", (days, expected) => {
    expect(formatRelativeTime(offset(days), NOW)).toBe(expected);
  });

  it("never renders a zero at the bottom of a band", () => {
    // 28 days is the first day of the month band: `floor(28 / 30)` is 0, so an
    // uncapped implementation says "0 months ago" here.
    for (const days of [7, 28, 365]) {
      expect(formatRelativeTime(offset(-days), NOW)).not.toMatch(/\b0 /);
    }
  });

  it("counts calendar days, not elapsed hours", () => {
    const justAfterMidnight = new Date(2026, 7, 6, 0, 30, 0);
    const lastNight = new Date(2026, 7, 5, 23, 0, 0).toISOString();

    // 90 minutes apart, but a different day — and "yesterday" is what a person
    // means by it.
    expect(formatRelativeTime(lastNight, justAfterMidnight)).toBe("yesterday");
  });

  it("returns null for anything it cannot date, so callers can drop the clause", () => {
    expect(formatRelativeTime(null, NOW)).toBeNull();
    expect(formatRelativeTime(undefined, NOW)).toBeNull();
    expect(formatRelativeTime("", NOW)).toBeNull();
    expect(formatRelativeTime("not a date", NOW)).toBeNull();
  });
});
