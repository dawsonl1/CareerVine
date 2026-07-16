import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { purgeScrapedData } from "@/lib/data-retention";

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

export const maxDuration = 60;

/**
 * POST /api/cron/data-retention
 * Daily QStash schedule (source of truth: scripts/qstash-schedules.mjs).
 * Purges scraped third-party data that has outlived its use (CAR-135 / R4.8):
 * stale unactioned discovery candidates, and soft-removed bundle prospects that
 * every subscriber has already synced past. Idempotent.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  return withCronGuard("/api/cron/data-retention", async () => {
    const service = createSupabaseServiceClient();
    const result = await purgeScrapedData({ service });
    return NextResponse.json(result);
  });
}
