/**
 * Rule: which contacts are due for a reach-out (CAR-155 extraction).
 *
 * Single source of the due/overdue policy. Consumed by getHomeCoreData
 * (which already holds the contacts), by the standalone getDueFollowUps
 * fetch wrapper in src/lib/data/follow-ups.ts, and through it by the MCP
 * list_due_followups tool — the surfaces cannot drift.
 *
 * Pure: no I/O, clock injected via nowIso. Active-only semantics are
 * enforced HERE (isActiveContact), not just at fetch call sites, so a
 * caller that forgets the SQL-level network_status filter cannot widen
 * the population (CAR-139 made the filters live; CAR-155 makes divergence
 * structurally impossible).
 */

import { getRecentCutoff } from "./clock";
import { dateKeyOf, daysBetweenDateKeys, shiftDateKey } from "@/lib/calendar-day";
import { isActiveContact } from "./network-status";

/** Source row shape for the reach-out derivation (matches the home fetch). */
export interface DueFollowUpSourceRow {
  id: number;
  name: string;
  industry: string | null;
  follow_up_frequency_days: number | null;
  photo_url: string | null;
  created_at: string;
  first_outreach_skipped: boolean | null;
  reach_out_snoozed_until: string | null;
  network_status: string;
  contact_emails: Array<{ email: string | null }> | null;
}

export interface DueFollowUpEntry {
  id: number;
  name: string;
  industry: string | null;
  photo_url: string | null;
  follow_up_frequency_days: number;
  last_touch: string | null;
  days_overdue: number;
  never_contacted: boolean;
  no_cadence: boolean;
  emails: string[];
}

/**
 * Derive the "reach out" list from a set of contacts + their last-touch map.
 */
export function deriveDueFollowUps(
  contacts: DueFollowUpSourceRow[],
  lastTouchMap: Map<number, string>,
  nowIso: string,
): DueFollowUpEntry[] {
  // Every instant below comes off nowIso: within one getHomeCoreData response
  // followUps must be evaluated against the same clock as its sibling outputs,
  // and the derivation stays deterministic under test.
  const now = new Date(nowIso);
  const recentCutoff = getRecentCutoff(nowIso);
  // Local calendar today. Day counts below are calendar-day differences, not
  // elapsed-millisecond divisions against a local midnight (CAR-206): the old
  // form mixed a local day boundary with a raw instant and came out one short
  // at half-hour offsets and across DST.
  const todayKey = dateKeyOf(now);
  const isSnoozed = (c: DueFollowUpSourceRow) =>
    Boolean(c.reach_out_snoozed_until && new Date(c.reach_out_snoozed_until) > now);

  return contacts
    .filter(isActiveContact) // reach-out prompts cover the real network only
    .map((c) => {
      if (isSnoozed(c)) return null;

      const lastTouch = lastTouchMap.get(c.id);
      const lastTouchDate = lastTouch ? new Date(lastTouch) : null;
      const freqDays = c.follow_up_frequency_days;
      const neverContacted = !lastTouchDate;
      const noCadence = !freqDays;
      const isRecent = c.created_at >= recentCutoff;

      if (neverContacted && (isRecent || c.first_outreach_skipped)) return null;

      const emails = (c.contact_emails || [])
        .map((e) => e.email)
        .filter((email): email is string => email !== null);

      if (noCadence) {
        if (!neverContacted || !isRecent) {
          return {
            id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
            follow_up_frequency_days: 0, last_touch: lastTouch || null,
            days_overdue: 0, never_contacted: neverContacted, no_cadence: true,
            emails,
          };
        }
        return null;
      }

      // The touch is read as an instant and reduced to its LOCAL calendar day.
      // interaction_date genuinely is an instant; meeting_date is a naive wall
      // clock stored as UTC, so for an evening meeting west of UTC this can name
      // the next day. That imprecision predates CAR-206 and is shared by every
      // other last_touch consumer (all of them do `new Date(last_touch)`), so it
      // is left uniform here rather than made locally clever and inconsistent.
      const anchorKey = dateKeyOf(neverContacted ? new Date(c.created_at) : lastTouchDate!);
      const dueKey = shiftDateKey(anchorKey, freqDays!);
      const daysOverdue = daysBetweenDateKeys(dueKey, todayKey);
      if (daysOverdue < 0) return null;

      return {
        id: c.id, name: c.name, industry: c.industry, photo_url: c.photo_url,
        follow_up_frequency_days: freqDays!, last_touch: lastTouch || null,
        days_overdue: daysOverdue, never_contacted: neverContacted, no_cadence: false,
        emails,
      };
    })
    .filter((c): c is DueFollowUpEntry => c !== null)
    .sort((a, b) => {
      if (a.no_cadence && !b.no_cadence) return 1;
      if (!a.no_cadence && b.no_cadence) return -1;
      return b.days_overdue - a.days_overdue;
    });
}
