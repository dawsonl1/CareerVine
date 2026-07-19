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

import { startOfDay } from "./clock";

/**
 * Count the streak from a set of active day strings (YYYY-MM-DD, as produced
 * by splitting the activity tables' timestamps on "T").
 */
export function deriveNetworkingStreak(activeDays: ReadonlySet<string>, nowIso: string): number {
  const today = startOfDay(nowIso);

  let streak = 0;
  const checkDate = new Date(today);
  // Include today if there's activity
  const todayStr = today.toISOString().split("T")[0];
  if (activeDays.has(todayStr)) {
    streak = 1;
    checkDate.setDate(checkDate.getDate() - 1);
  } else {
    // Start from yesterday
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    const dateStr = checkDate.toISOString().split("T")[0];
    if (activeDays.has(dateStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  return streak;
}
