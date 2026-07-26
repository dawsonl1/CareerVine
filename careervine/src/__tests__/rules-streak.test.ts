/**
 * Unit tests for the networking-streak rule (CAR-155).
 *
 * Network status deliberately does not apply here: the streak counts activity
 * (meetings, completed action items, interactions), not contacts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { deriveNetworkingStreak } from "@/lib/rules/streak";
import { dateKeyOf, shiftDateKey } from "@/lib/calendar-day";

const NOW = "2026-04-10T12:00:00.000Z";

/**
 * A day key N days before NOW, built the way the PRODUCER builds them
 * (`dateKeyOf` on an activity instant, in src/lib/data/home.ts).
 *
 * It used to be built with `startOfDay(NOW).setDate(-n).toISOString().split("T")[0]`
 * — the same expression the rule itself used. Deriving both sides of a comparison
 * through one transformation makes the assertion true by construction: the suite
 * stayed green through the entire period when the rule compared a local day
 * against UTC-bucketed activity, because the fixture made the same mistake
 * (CAR-206). A test fixture must not reproduce the implementation it checks.
 */
const daysAgo = (n: number): string => shiftDateKey(dateKeyOf(new Date(NOW)), -n);

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

/**
 * CAR-206. The rule derived "today" as a local midnight pushed back through
 * `toISOString()` — which east of UTC names YESTERDAY — while its caller bucketed
 * activity by UTC date. Two different notions of a day, compared against each
 * other. Neither the old tests nor the old fixture could see it, because the
 * fixture used the same expression the rule did.
 */
describe("deriveNetworkingStreak — the streak does not depend on the viewer's zone", () => {
  const ZONES = ["UTC", "America/Denver", "Pacific/Auckland", "Asia/Kolkata", "Asia/Kathmandu"];
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("counts the same run of days in every zone", () => {
    const answers = ZONES.map((tz) => {
      process.env.TZ = tz;
      // Built per-zone exactly as the fetch site builds them, from instants.
      const days = new Set([1, 2, 3].map((n) => shiftDateKey(dateKeyOf(new Date(NOW)), -n)));
      return deriveNetworkingStreak(days, NOW);
    });
    expect(answers).toEqual(ZONES.map(() => 3));
  });

  it("counts an activity logged this evening toward TODAY, west of UTC", () => {
    // 19:00 Denver on 2026-04-09 is 2026-04-10 in UTC. Bucketing that by UTC put
    // it on tomorrow's key, so an evening of networking never counted for the day
    // it happened.
    process.env.TZ = "America/Denver";
    const evening = new Date("2026-04-09T19:00:00-06:00");
    const nowIso = "2026-04-09T21:00:00-06:00";
    const days = new Set([dateKeyOf(evening)]);
    expect(deriveNetworkingStreak(days, nowIso)).toBe(1);
  });
});
