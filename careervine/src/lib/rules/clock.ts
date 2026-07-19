/**
 * Shared clock helpers for the relationship rules (CAR-155).
 *
 * Pure: everything derives from an explicit ISO instant so rule evaluation
 * is deterministic under test and every surface in one response can pin to
 * a single clock.
 */

import { RECENTLY_ADDED_DAYS } from "@/lib/constants";

/**
 * Get the ISO cutoff string for the "Recently Added" window.
 * Takes an optional instant so a caller can pin every derived surface in one
 * response to a single clock; defaults to wall-clock now for the rest.
 */
export function getRecentCutoff(nowIso?: string): string {
  const d = nowIso ? new Date(nowIso) : new Date();
  d.setDate(d.getDate() - RECENTLY_ADDED_DAYS);
  return d.toISOString();
}

/**
 * Local-midnight Date for the instant — the day bucket the rules have always
 * used for "days since" arithmetic.
 */
export function startOfDay(nowIso: string): Date {
  const d = new Date(nowIso);
  d.setHours(0, 0, 0, 0);
  return d;
}
