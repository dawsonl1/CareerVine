/**
 * Outreach-flow queue builder (plan 25).
 *
 * Decides which target companies enter the company-by-company flow and
 * in what order:
 *  - target companies only, status != 'closed'
 *  - must have ≥1 contactable person (active/prospect current or former;
 *    bench never qualifies a company)
 *  - companies with a real next_app_date within the boost window jump to
 *    the front (soonest first) — a deadline beats generic priority
 *  - then priority score desc (nulls last), then name
 */

import type { CompanySummary } from "./company-queries";

export const APP_DATE_BOOST_DAYS = 30;

export interface OutreachQueueResult {
  queue: CompanySummary[];
  /** Target companies excluded for having nobody contactable (incl. bench-only). */
  skippedCount: number;
}

export function buildOutreachQueue(
  summaries: CompanySummary[],
  todayIso: string,
): OutreachQueueResult {
  const today = todayIso.slice(0, 10);
  const boostCutoff = new Date(`${today}T00:00:00Z`);
  boostCutoff.setUTCDate(boostCutoff.getUTCDate() + APP_DATE_BOOST_DAYS);
  const cutoff = boostCutoff.toISOString().slice(0, 10);

  const targets = summaries.filter((c) => c.target && c.target.status !== "closed");
  const queue = targets.filter((c) => c.current_count + c.former_count > 0);
  const skippedCount = targets.length - queue.length;

  const isBoosted = (c: CompanySummary) => {
    const d = c.target?.next_app_date;
    return Boolean(d && d >= today && d <= cutoff);
  };

  queue.sort((a, b) => {
    const boostA = isBoosted(a);
    const boostB = isBoosted(b);
    if (boostA !== boostB) return boostA ? -1 : 1;
    if (boostA && boostB) {
      // Both inside the window: soonest deadline first
      const cmp = (a.target!.next_app_date as string).localeCompare(b.target!.next_app_date as string);
      if (cmp !== 0) return cmp;
    }
    const pa = a.target?.priority_score;
    const pb = b.target?.priority_score;
    if (pa != null || pb != null) {
      if (pa == null) return 1;
      if (pb == null) return -1;
      if (pa !== pb) return pb - pa;
    }
    return a.name.localeCompare(b.name);
  });

  return { queue, skippedCount };
}
