import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { processDueScheduledEmails } from "@/lib/scheduled-email-cron";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { recordWatcherBeat, checkWatcherHealth } from "@/lib/watcher-health";

export const maxDuration = 60;

/**
 * POST /api/cron/send-scheduled-emails
 *
 * Two drivers call this (CAR-215):
 *   - the A1 send watcher, within ~15s of anything coming due. This is what
 *     makes a scheduled email actually land at the time the user picked.
 *   - QStash, hourly, as a safety net so a dead watcher degrades delivery to
 *     hourly rather than stopping it.
 *
 * Concurrent drivers are safe: every row is claimed with a CAS
 * (pending -> sending) before it is sent, so whichever driver loses the race
 * skips it (CAR-134 / CAR-179).
 *
 * The two also keep each other honest. The watcher stamps its liveness here;
 * the safety-net path reads that stamp and emails the owner when it has gone
 * stale, because a watcher that dies quietly would otherwise just look like
 * "email has been a bit late lately".
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(req, (_body, source) =>
    withCronGuard("/api/cron/send-scheduled-emails", async () => {
      const service = createSupabaseServiceClient();

      // Liveness bookkeeping first, so a slow or failing sweep still leaves an
      // accurate record of who was driving.
      let watcherStale = false;
      let watcherQuietMinutes: number | null = null;
      let watcherAlerted = false;
      if (source === "watcher") {
        await recordWatcherBeat(service);
      } else {
        const health = await checkWatcherHealth(service);
        watcherStale = health.stale;
        watcherQuietMinutes = health.quietMinutes;
        watcherAlerted = health.alerted;
      }

      const result = await processDueScheduledEmails();
      return NextResponse.json({
        ...result,
        driver: source,
        ...(watcherStale ? { watcherStale, watcherQuietMinutes, watcherAlerted } : {}),
      });
    }),
  );
}
