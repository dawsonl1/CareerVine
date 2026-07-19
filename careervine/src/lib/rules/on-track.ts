/**
 * Rule: "Relationships on track" percentage (CAR-155 extraction).
 *
 * Single source of the on-track policy. Consumed by the web dashboard and
 * the MCP get_network_health tool through the getRelationshipsOnTrack fetch
 * wrapper in src/lib/data/follow-ups.ts.
 *
 * Denominator: contacts contacted at least once OR past the 7-day Recently
 * Added window (excluding first_outreach_skipped). Numerator: contacts with
 * days_since_last_touch <= follow_up_frequency_days. No cadence set means
 * automatically NOT on track.
 *
 * Pure: no I/O, clock injected via nowIso. Active-only semantics enforced
 * HERE (isActiveContact), not just at fetch call sites.
 */

import { getRecentCutoff, startOfDay } from "./clock";
import { isActiveContact } from "./network-status";

export interface OnTrackSourceRow {
  id: number;
  follow_up_frequency_days: number | null;
  created_at: string;
  first_outreach_skipped: boolean | null;
  network_status: string;
}

export interface RelationshipsOnTrack {
  percentage: number;
  onTrack: number;
  total: number;
  breakdown: {
    withCadenceOnTrack: number;
    withCadenceOverdue: number;
    noCadence: number;
    neverContactedPast7d: number;
  };
}

export function deriveRelationshipsOnTrack(
  contacts: OnTrackSourceRow[],
  lastTouchMap: Map<number, string>,
  nowIso: string,
): RelationshipsOnTrack {
  const recentCutoff = getRecentCutoff(nowIso);
  const today = startOfDay(nowIso);

  let onTrack = 0;
  let total = 0;
  let withCadenceOnTrack = 0;
  let withCadenceOverdue = 0;
  let noCadence = 0;
  let neverContactedPast7d = 0;

  for (const c of contacts) {
    if (!isActiveContact(c)) continue; // on-track % covers the real network only
    if (c.first_outreach_skipped) continue;

    const lastTouch = lastTouchMap.get(c.id);
    const hasBeenContacted = !!lastTouch;
    const isRecent = c.created_at >= recentCutoff;

    // Include if: contacted at least once, OR past 7-day window
    if (!hasBeenContacted && isRecent) continue; // Still in Recently Added — skip

    total++;

    if (!hasBeenContacted) {
      // Past 7 days, never contacted
      neverContactedPast7d++;
      if (c.follow_up_frequency_days) {
        // Has cadence — check if overdue from created_at
        const dueDate = new Date(c.created_at);
        dueDate.setDate(dueDate.getDate() + c.follow_up_frequency_days);
        if (today <= dueDate) {
          onTrack++;
          withCadenceOnTrack++;
        } else {
          withCadenceOverdue++;
        }
      } else {
        noCadence++;
        // No cadence = not on track
      }
      continue;
    }

    // Has been contacted
    if (!c.follow_up_frequency_days) {
      noCadence++;
      // No cadence = not on track
      continue;
    }

    const lastTouchDate = new Date(lastTouch!);
    const daysSince = Math.floor((today.getTime() - lastTouchDate.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince <= c.follow_up_frequency_days) {
      onTrack++;
      withCadenceOnTrack++;
    } else {
      withCadenceOverdue++;
    }
  }

  const percentage = total > 0 ? Math.round((onTrack / total) * 100) : 100;

  return {
    percentage,
    onTrack,
    total,
    breakdown: {
      withCadenceOnTrack,
      withCadenceOverdue,
      noCadence,
      neverContactedPast7d,
    },
  };
}
