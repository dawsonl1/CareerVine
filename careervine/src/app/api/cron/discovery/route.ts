import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { triggerDiscoveryBatch } from "@/lib/apify/discovery";
import { isApifyConfigured } from "@/lib/apify/client";

export const maxDuration = 60;

/**
 * POST /api/cron/discovery
 * Weekly QStash schedule (source of truth: scripts/qstash-schedules.mjs). The
 * discovery feed (plan 41 / CAR-29): per opted-in user, search
 * the stalest high-priority target companies for PMs who joined in the last
 * 90 days. Trigger-only — runs complete asynchronously via the Apify
 * webhook, so this stays well inside maxDuration. A QStash retry can't
 * double-spend: in-flight companies are excluded atomically (partial unique
 * index) and both spend caps fail closed.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () =>
    withCronGuard("/api/cron/discovery", () => runJob()),
  );
}

async function runJob(): Promise<NextResponse> {
  if (process.env.APIFY_SCRAPE_DISABLED === "true" || !isApifyConfigured()) {
    return NextResponse.json({ started: 0, disabled: true });
  }

  const service = createSupabaseServiceClient();
  // discovery_enabled is the feature's own admin switch (default OFF) — it is
  // deliberately independent of apify_enrichment_enabled.
  const { data: users } = await service
    .from("users")
    .select("id")
    .eq("status", "active")
    .eq("discovery_enabled", true);

  let started = 0;
  const perUser: Record<string, number> = {};
  for (const u of (users as { id: string }[] | null) ?? []) {
    try {
      const result = await triggerDiscoveryBatch(u.id);
      if (result.status === "started") {
        perUser[u.id] = result.companies;
        started += result.companies;
      }
    } catch (err) {
      console.error(`[cron discovery] user ${u.id} failed:`, err);
    }
  }

  return NextResponse.json({ started, perUser });
}
