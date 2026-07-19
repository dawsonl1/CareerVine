/**
 * Unit tests for the networking-streak rule (CAR-155).
 *
 * Network status deliberately does not apply here: the streak counts activity
 * (meetings, completed action items, interactions), not contacts.
 */

import { describe, expect, it } from "vitest";
import { deriveNetworkingStreak } from "@/lib/rules/streak";
import { startOfDay } from "@/lib/rules/clock";

const NOW = "2026-04-10T12:00:00.000Z";

/** Day string N days before NOW, in the same local-midnight bucketing the rule uses. */
const daysAgo = (n: number): string => {
  const d = startOfDay(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString().split("T")[0];
};

describe("deriveNetworkingStreak", () => {
  it("returns 0 with no activity", () => {
    expect(deriveNetworkingStreak(new Set(), NOW)).toBe(0);
  });

  it("counts consecutive days backward from yesterday when today is inactive", () => {
    const days = new Set([daysAgo(1), daysAgo(2), daysAgo(3)]);
    expect(deriveNetworkingStreak(days, NOW)).toBe(3);
  });

  it("includes today when it already has activity", () => {
    const days = new Set([daysAgo(0), daysAgo(1)]);
    expect(deriveNetworkingStreak(days, NOW)).toBe(2);
  });

  it("stops at the first gap", () => {
    const days = new Set([daysAgo(1), daysAgo(3), daysAgo(4)]);
    expect(deriveNetworkingStreak(days, NOW)).toBe(1);
  });

  it("does not break the streak on a quiet today", () => {
    // Today inactive is 'in progress', not a gap — yesterday-anchored count.
    const days = new Set([daysAgo(1)]);
    expect(deriveNetworkingStreak(days, NOW)).toBe(1);
  });
});
