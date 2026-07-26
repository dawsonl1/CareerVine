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
describe("deriveNetworkingStreak — day basis (CAR-206)", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  /**
   * The discriminating case, and it took two attempts to find.
   *
   * The first version of this test asserted a 3-day run stayed 3 across a list
   * of zones. It passed against the OLD implementation too: a contiguous run is
   * shift-invariant, so sliding the whole window by one day still finds a run of
   * three. A test that cannot see a one-day offset is no use against a one-day
   * offset bug.
   *
   * What discriminates is a set with a HOLE at the boundary. East of UTC the old
   * `startOfDay(nowIso).toISOString().split("T")[0]` names yesterday (measured:
   * at 2026-04-10T12:00Z, Auckland local is Apr 11 but that expression yields
   * 2026-04-10), so today's activity was looked up under the wrong key.
   */
  it("counts activity on TODAY east of UTC, where a UTC round trip names yesterday", () => {
    process.env.TZ = "Pacific/Auckland";
    const nowIso = "2026-04-10T12:00:00.000Z"; // Apr 11 00:00 local
    const activeToday = new Set([dateKeyOf(new Date(nowIso))]); // "2026-04-11"
    // Old basis looked up "2026-04-10", which is not in the set, and returned 0.
    expect(deriveNetworkingStreak(activeToday, nowIso)).toBe(1);
  });

  it("still treats a quiet today as in-progress rather than a gap, east of UTC", () => {
    process.env.TZ = "Pacific/Auckland";
    const nowIso = "2026-04-10T12:00:00.000Z";
    const yesterdayOnly = new Set([shiftDateKey(dateKeyOf(new Date(nowIso)), -1)]);
    expect(deriveNetworkingStreak(yesterdayOnly, nowIso)).toBe(1);
  });

  it("counts an evening activity toward the day it happened, west of UTC", () => {
    // 19:00 Denver on Apr 9 is Apr 10 in UTC. The fetch site used to bucket that
    // by its UTC date, so an evening of networking landed on tomorrow's key.
    process.env.TZ = "America/Denver";
    const evening = new Date("2026-04-09T19:00:00-06:00");
    expect(dateKeyOf(evening)).toBe("2026-04-09");
    expect(evening.toISOString().split("T")[0]).toBe("2026-04-10"); // the old bucketing
    expect(deriveNetworkingStreak(new Set([dateKeyOf(evening)]), "2026-04-09T21:00:00-06:00")).toBe(1);
  });

  it("gives the same answer in every zone for a run anchored on today", () => {
    for (const tz of ["UTC", "America/Denver", "Pacific/Auckland", "Asia/Kolkata", "Asia/Kathmandu"]) {
      process.env.TZ = tz;
      const today = dateKeyOf(new Date(NOW));
      const days = new Set([0, 1, 2].map((n) => shiftDateKey(today, -n)));
      expect(deriveNetworkingStreak(days, NOW)).toBe(3);
    }
  });
});
