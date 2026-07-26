/**
 * Rule: networking streak (CAR-155 extraction).
 *
 * Consecutive days with at least one networking activity (meeting logged,
 * action item completed, or interaction), counted backward from yesterday —
 * today is still in progress, but counts when it already has activity.
 *
 * Single source of the streak policy. Consumed by the web dashboard and the
 * MCP get_network_health tool through the getNetworkingStreak fetch wrapper
 * in src/lib/data/home.ts.
 *
 * Pure: no I/O, clock injected via nowIso. Network-status does not apply
 * here by design — the streak reads activity tables (meetings, action items,
 * interactions), not the contact list.
 */

import { dateKeyOf, shiftDateKey } from "@/lib/calendar-day";

/**
 * Count the streak from a set of active day keys (YYYY-MM-DD in the LOCAL
 * calendar, as produced by `dateKeyOf` at the fetch site — not by splitting a
 * timestamp on "T", which yields the UTC day and is a different thing).
 */
export function deriveNetworkingStreak(activeDays: ReadonlySet<string>, nowIso: string): number {
  // Local calendar keys on BOTH sides (CAR-206). This used to derive "today" as
  // startOfDay(nowIso).toISOString().split("T")[0] — a local midnight pushed
  // back through UTC, which east of UTC names YESTERDAY — while its caller
  // bucketed activity timestamps by their UTC date. Two different notions of a
  // day were being compared, so an evening's work west of UTC counted toward
  // tomorrow and a morning's east of UTC counted toward yesterday.
  const todayKey = dateKeyOf(new Date(nowIso));

  let streak = 0;
  // Today counts when it already has activity, but a quiet today is "in
  // progress" rather than a gap, so the walk always starts at yesterday.
  if (activeDays.has(todayKey)) streak = 1;

  let cursor = shiftDateKey(todayKey, -1);
  while (activeDays.has(cursor)) {
    streak++;
    cursor = shiftDateKey(cursor, -1);
  }

  return streak;
}
