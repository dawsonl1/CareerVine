/**
 * Apify spend accounting (plan 29 §9.3, plan 41 §3.5) — extracted from
 * scrape-service so the discovery module can share it without an import cycle.
 *
 * All readers fail CLOSED: a query error throws so no caller ever treats an
 * error as $0 and starts a paid run against an unknown balance.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  DISCOVERY_PAGE_COST_USD,
  SCRAPE_UNIT_COST_USD,
  ScrapeMode,
  ScrapeRunStatus,
} from "@/lib/constants";

export function monthStartIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * Estimated cost of a run the ledger can't price exactly (pending reserve,
 * lost-webhook sweep, charged-but-unprocessed ingest failure). Discovery runs
 * are priced per search page, not per contact — the contact-count formula
 * would under-price them ~10× (plan 41 audit).
 */
export function estimateRunCostUsd(mode: string, contactCount: number, fallbackUnit: number): number {
  if (mode === ScrapeMode.Discovery) return DISCOVERY_PAGE_COST_USD;
  const unit = SCRAPE_UNIT_COST_USD[mode as keyof typeof SCRAPE_UNIT_COST_USD] ?? fallbackUnit;
  return Math.max(1, contactCount) * unit;
}

/**
 * Effective month-to-date spend for the cap check: settled cost (server-side
 * SUM, so it can't be truncated by the client's row ceiling) plus a
 * conservative reserve for still-in-flight runs whose cost hasn't landed yet.
 * Throws on query error so the caller fails CLOSED (never treats an error as $0).
 */
export async function getMonthlySpendUsd(userId: string): Promise<number> {
  const service = createSupabaseServiceClient();
  const since = monthStartIso();

  const { data: settled, error: sumError } = await service.rpc("sum_scrape_spend", {
    p_user_id: userId,
    p_since: since,
  });
  if (sumError) throw new Error(`spend sum failed: ${sumError.message}`);

  const { data: pending, error: pendingError } = await service
    .from("scrape_runs")
    .select("mode, contact_ids")
    .eq("user_id", userId)
    .eq("status", ScrapeRunStatus.Pending)
    .gte("created_at", since);
  if (pendingError) throw new Error(`pending fetch failed: ${pendingError.message}`);

  // Reserve each in-flight run at its ACTUAL size × unit cost — a pending
  // cadence batch covers up to 25 profiles, so a flat per-run penny would
  // under-reserve ~25× and let concurrent batches blow past the cap.
  const reserve = ((pending as { mode: string; contact_ids: number[] }[] | null) ?? []).reduce(
    (sum, r) => sum + estimateRunCostUsd(r.mode, r.contact_ids?.length ?? 1, SCRAPE_UNIT_COST_USD.email),
    0,
  );
  return Number(settled ?? 0) + reserve;
}

/**
 * Month-to-date DISCOVERY spend (settled + in-flight reserve). Discovery has
 * its own soft budget lane: the weekly search must never eat the cadence
 * drip's soft cap, and vice versa (plan 41 §3.5). Fails closed.
 */
export async function getDiscoverySpendUsd(userId: string): Promise<number> {
  const service = createSupabaseServiceClient();
  const since = monthStartIso();

  const { data: settled, error: sumError } = await service.rpc("sum_scrape_spend_mode", {
    p_user_id: userId,
    p_since: since,
    p_mode: ScrapeMode.Discovery,
  });
  if (sumError) throw new Error(`discovery spend sum failed: ${sumError.message}`);

  const { count, error: pendingError } = await service
    .from("scrape_runs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", ScrapeRunStatus.Pending)
    .eq("mode", ScrapeMode.Discovery)
    .gte("created_at", since);
  if (pendingError) throw new Error(`discovery pending fetch failed: ${pendingError.message}`);

  return Number(settled ?? 0) + (count ?? 0) * DISCOVERY_PAGE_COST_USD;
}
