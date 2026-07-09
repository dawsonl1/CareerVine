/**
 * Cadence eligibility selection (plan 29 §7.3).
 *
 * Picks the day's re-scrape batch for a user: stalest first (never-scraped
 * contacts lead — last_scraped_at NULLS FIRST), active/prospect before bench,
 * excluding suppressed URLs (the drip would otherwise re-select a tombstoned
 * contact forever), contacts already covered by an in-flight run, and
 * contacts in failure backoff.
 */

import { canonicalizeLinkedinUrl } from "@/lib/linkedin-url";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { DAILY_CADENCE_TARGET, SCRAPE_DEBOUNCE_DAYS, ScrapeRunStatus } from "@/lib/constants";

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
  const picked: CadenceCandidate[] = [];
  const seen = new Set<string>();

  // Active/prospect before bench: two passes over the same selection logic.
  for (const statuses of [["active", "prospect"], ["bench"]]) {
    if (picked.length >= target) break;
    const { data: rows } = await service
      .from("contacts")
      .select("id, linkedin_url, last_scraped_at, scrape_failed_at")
      .eq("user_id", userId)
      .in("network_status", statuses)
      .not("linkedin_url", "is", null)
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
