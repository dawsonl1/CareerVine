import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { runRecentSyncSweep } from "@/lib/gmail-sync-cron";

export const maxDuration = 60;

/**
 * POST /api/cron/sync-gmail-recent
 *
 * Narrow Gmail sweep, driven from the A1 box (CAR-234). Only contacts on a live
 * follow-up sequence or written to in the last 9 days, which is every contact a
 * reply to our own outreach could come from.
 *
 * The cadence lives in `ops/gmail-sync/careervine-sync-recent.timer`, not here.
 * A route cannot know how often it is called, and a header that names an
 * interval is a claim that silently rots the first time the timer changes.
 *
 * Separate route rather than a flag on the full sweep, for the reason spelled
 * out in that route's header: the bearer path has no body signature, so each
 * opted-in route must choose its own work server-side.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(
    req,
    (_body, source) =>
      withCronGuard("/api/cron/sync-gmail-recent", async () => {
        const result = await runRecentSyncSweep(createSupabaseServiceClient());
        return NextResponse.json({ ...result, driver: source });
      }),
    { allowCronBearer: true },
  );
}
