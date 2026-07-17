import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { purgeScrapedData } from "@/lib/data-retention";

export const maxDuration = 60;

/**
 * POST /api/cron/data-retention
 * Daily QStash schedule (source of truth: scripts/qstash-schedules.mjs).
 * Purges scraped third-party data that has outlived its use (CAR-135 / R4.8):
 * stale unactioned discovery candidates, and soft-removed bundle prospects that
 * every subscriber has already synced past. Idempotent.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, () => withCronGuard("/api/cron/data-retention", async () => {
    const service = createSupabaseServiceClient();
    const result = await purgeScrapedData({ service });
    return NextResponse.json(result);
  }));
}
