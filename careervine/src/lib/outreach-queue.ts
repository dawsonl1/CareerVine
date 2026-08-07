/**
 * Outreach-flow queue builder (plan 25).
 *
 * Decides which target companies enter the company-by-company flow and
 * in what order:
 *  - target companies only, status != 'closed'
 *  - must have ≥1 active/prospect person who works there NOW (bench never
 *    qualifies a company, and neither does a former employee — CAR-259)
 *  - companies with a real next_app_date within the boost window jump to
 *    the front (soonest first) — a deadline beats generic priority
 *  - then priority score desc (nulls last), then name
 */

import type { CompanyBaseSummary, CompanySummary } from "./company-queries";

export const APP_DATE_BOOST_DAYS = 30;

export interface OutreachQueueResult<T extends CompanyBaseSummary = CompanySummary> {
  queue: T[];
  /**
   * Target companies excluded for having nobody there to reach: no current
   * employees at all, only bench people, or a roster who have all since left.
   */
  skippedCount: number;
}

/**
 * Generic over the summary shape, and bounded at CompanyBaseSummary rather than
 * CompanySummary, because that is genuinely all this reads: `target` (status,
 * next_app_date, priority_score), the two contact counts, and `name`. /outreach
 * fetches its queue with `enrich: false` and so has nothing else to give it,
 * while MCP's list_outreach_queue passes full summaries and gets full summaries
 * back — `T` carries the caller's own row type straight through.
 */
export function buildOutreachQueue<T extends CompanyBaseSummary>(
  summaries: T[],
  todayIso: string,
): OutreachQueueResult<T> {
  const today = todayIso.slice(0, 10);
  const boostCutoff = new Date(`${today}T00:00:00Z`);
  boostCutoff.setUTCDate(boostCutoff.getUTCDate() + APP_DATE_BOOST_DAYS);
  const cutoff = boostCutoff.toISOString().slice(0, 10);

  const targets = summaries.filter((c) => c.target && c.target.status !== "closed");
  // CURRENT employees only (CAR-259). This used to read
  // `current_count + former_count > 0`, so a company whose entire roster had
  // moved on still got its own screen in the walkthrough, presented as outreach
  // to do — 53 of Dawson's 182 queued companies, Qualtrics among them with 20
  // contacts and not one of them still there. Former employees stay reachable
  // everywhere else (the company roster's Former group, contact search); they
  // just stop generating a "here is who to email about a job HERE" prompt,
  // because there is no job here to email them about.
  const queue = targets.filter((c) => c.current_count > 0);
  const skippedCount = targets.length - queue.length;

  const isBoosted = (c: CompanyBaseSummary) => {
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
