/**
 * Rule: neglected relationships (CAR-155 extraction).
 *
 * A contact is neglected when a cadence is set and they are either 2x+ past
 * it, or never contacted at all (unless the user explicitly silenced the
 * first-outreach nag — the flag gates never-contacted people only, matching
 * deriveDueFollowUps, so someone already contacted stays legitimately
 * neglectable). Sorted by overdue ratio, worst first.
 *
 * Single source of the neglected policy. Consumed by the web dashboard and
 * the MCP get_network_health tool through the getNeglectedContacts fetch
 * wrapper in src/lib/data/follow-ups.ts.
 *
 * Pure: no I/O; operates on rows whose days_since_touch was computed against
 * the caller's clock. Active-only semantics enforced HERE (isActiveContact),
 * not just at fetch call sites.
 */

import { isActiveContact } from "./network-status";

export interface NeglectedSourceRow {
  id: number;
  name: string;
  photo_url: string | null;
  follow_up_frequency_days: number | null;
  first_outreach_skipped: boolean | null;
  network_status: string;
  /** Floor days since last touch; null means never contacted. */
  days_since_touch: number | null;
}

export interface NeglectedContact {
  id: number;
  name: string;
  photo_url: string | null;
  days_since_touch: number | null;
  follow_up_frequency_days: number | null;
}

export function deriveNeglectedContacts(contacts: NeglectedSourceRow[]): NeglectedContact[] {
  return contacts
    .filter(isActiveContact) // the neglected list covers the real network only
    .filter((c) => {
      if (!c.follow_up_frequency_days || c.follow_up_frequency_days <= 0) return false;
      if (c.days_since_touch === null) return !c.first_outreach_skipped;
      return c.days_since_touch >= c.follow_up_frequency_days * 2;
    })
    .sort((a, b) => {
      const aRatio = a.days_since_touch !== null && a.follow_up_frequency_days
        ? a.days_since_touch / a.follow_up_frequency_days : 999;
      const bRatio = b.days_since_touch !== null && b.follow_up_frequency_days
        ? b.days_since_touch / b.follow_up_frequency_days : 999;
      return bRatio - aRatio;
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      photo_url: c.photo_url,
      days_since_touch: c.days_since_touch,
      follow_up_frequency_days: c.follow_up_frequency_days,
    }));
}
