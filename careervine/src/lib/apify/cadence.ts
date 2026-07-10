/**
 * Cadence eligibility selection (plan 29 §7.3).
 *
 * Picks the day's re-scrape batch for a user: stalest first (never-scraped
 * contacts lead — last_scraped_at NULLS FIRST), active/prospect before bench,
 * excluding suppressed URLs (the drip would otherwise re-select a tombstoned
 * contact forever), contacts already covered by an in-flight run, contacts in
 * failure backoff, contacts scraped more recently than CADENCE_MIN_AGE_DAYS
 * (a small fleet must not burn the cap on daily re-scrapes of fresh data),
 * and profiles past the re-link threshold (paying to re-fail a dead URL).
 */

import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  CADENCE_MIN_AGE_DAYS,
  DAILY_CADENCE_TARGET,
  SCRAPE_DEBOUNCE_DAYS,
  SCRAPE_FAILURES_BEFORE_RELINK,
  ScrapeRunStatus,
} from "@/lib/constants";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

interface CandidateRow {
  id: number;
  linkedin_url: string | null;
  last_scraped_at: string | null;
  scrape_failed_at: string | null;
}

export interface CadenceCandidate {
  contactId: number;
  url: string;
}

export async function selectCadenceCandidates(
  service: ServiceClient,
  userId: string,
  target: number = DAILY_CADENCE_TARGET,
): Promise<CadenceCandidate[]> {
  // Contacts already covered by an in-flight run.
  const { data: pendingRuns } = await service
    .from("scrape_runs")
    .select("contact_ids")
    .eq("user_id", userId)
    .eq("status", ScrapeRunStatus.Pending);
  const inFlight = new Set<number>(
    ((pendingRuns as { contact_ids: number[] }[] | null) ?? []).flatMap((r) => r.contact_ids ?? []),
  );

  // Suppression tombstones (stored canonical).
  const { data: suppressedRows } = await service
    .from("suppressed_imports")
    .select("linkedin_url")
    .eq("user_id", userId);
  const suppressed = new Set(
    ((suppressedRows as { linkedin_url: string }[] | null) ?? []).map((r) => r.linkedin_url),
  );

  const backoffCutoff = Date.now() - SCRAPE_DEBOUNCE_DAYS * 24 * 60 * 60 * 1000;
  const backoffCutoffIso = new Date(backoffCutoff).toISOString();
  const minAgeCutoffIso = new Date(Date.now() - CADENCE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const picked: CadenceCandidate[] = [];
  const seen = new Set<string>();

  // Active/prospect before bench: two passes over the same selection logic.
  // Freshness/backoff/dead-profile exclusions live in SQL so excluded rows
  // don't consume the fetch window (nullsFirst would otherwise let a block of
  // in-backoff never-scraped contacts starve everyone behind them).
  for (const statuses of [["active", "prospect"], ["bench"]]) {
    if (picked.length >= target) break;
    const { data: rows } = await service
      .from("contacts")
      .select("id, linkedin_url, last_scraped_at, scrape_failed_at")
      .eq("user_id", userId)
      .in("network_status", statuses)
      .not("linkedin_url", "is", null)
      .or(`last_scraped_at.is.null,last_scraped_at.lt.${minAgeCutoffIso}`)
      .or(`scrape_failed_at.is.null,scrape_failed_at.lt.${backoffCutoffIso}`)
      .lt("scrape_failure_count", SCRAPE_FAILURES_BEFORE_RELINK)
      .order("last_scraped_at", { ascending: true, nullsFirst: true })
      .limit(target * 2); // headroom for exclusions

    for (const row of (rows as CandidateRow[] | null) ?? []) {
      if (picked.length >= target) break;
      if (inFlight.has(row.id)) continue;
      if (row.scrape_failed_at && new Date(row.scrape_failed_at).getTime() > backoffCutoff) continue;
      const url = canonicalizeLinkedinUrl(row.linkedin_url);
      if (!url || suppressed.has(url) || seen.has(url)) continue;
      seen.add(url);
      picked.push({ contactId: row.id, url });
    }
  }

  return picked;
}
