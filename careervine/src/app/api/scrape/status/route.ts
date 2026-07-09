import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { isApifyConfigured } from "@/lib/apify/client";
import { MONTHLY_SCRAPE_CAP_USD, ScrapeRunStatus } from "@/lib/constants";

/**
 * GET /api/scrape/status — the Settings "Data & Scraping" readout (plan 29
 * §6.6): month-to-date spend vs the hard cap, run counts, cadence heartbeat,
 * and whether scraping is configured/enabled at all.
 */
export const GET = withApiHandler({
  handler: async ({ user }) => {
    const service = createSupabaseServiceClient();
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();

    const { data: rows } = await service
      .from("scrape_runs")
      .select("status, cost_usd, trigger, created_at")
      .eq("user_id", user.id)
      .gte("created_at", monthStart)
      .order("created_at", { ascending: false })
      .limit(1000);

    const runs = (rows as Array<{ status: string; cost_usd: number; trigger: string; created_at: string }> | null) ?? [];
    const counts: Record<string, number> = { pending: 0, succeeded: 0, failed: 0, timed_out: 0 };
    let spendUsd = 0;
    let lastCadenceAt: string | null = null;
    for (const r of runs) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
      spendUsd += Number(r.cost_usd || 0);
      if (!lastCadenceAt && r.trigger === "cadence") lastCadenceAt = r.created_at;
    }

    return {
      success: true,
      configured: isApifyConfigured(),
      killSwitch: process.env.APIFY_SCRAPE_DISABLED === "true",
      capUsd: MONTHLY_SCRAPE_CAP_USD,
      spendUsd: Math.round(spendUsd * 10000) / 10000,
      pendingRuns: counts[ScrapeRunStatus.Pending],
      counts,
      lastCadenceAt,
      monthStart,
    };
  },
});
