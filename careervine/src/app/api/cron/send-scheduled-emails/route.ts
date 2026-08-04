import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { processDueScheduledEmails } from "@/lib/scheduled-email-cron";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  recordDriverBeat,
  checkWatcherHealth,
  SEND_WATCHER,
  QSTASH_SAFETY_NET,
} from "@/lib/watcher-health";

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
 * Both drivers stamp their own liveness row, and the safety-net path reads the
 * watcher's and emails the owner when it has gone stale. The reverse direction
 * is NOT wired: nothing reads the QStash stamp, so a paused schedule is still
 * invisible (see watcher-health.ts). Stated plainly because CAR-215 claimed the
 * pairing was mutual when only half of it existed.
 */
export async function POST(req: NextRequest) {
  return withQStashVerification(
    req,
    (_body, source) =>
      withCronGuard("/api/cron/send-scheduled-emails", async () => {
        const service = createSupabaseServiceClient();

        // Cheap, no network, already error-logged: safe ahead of the sweep, and
        // keeps "who was driving" accurate even when the sweep then fails.
        await recordDriverBeat(
          service,
          source === "watcher" ? SEND_WATCHER : QSTASH_SAFETY_NET,
        );

        // Delivery FIRST (CAR-220). checkWatcherHealth can email the owner, and
        // it only has something to say when the watcher is dead — precisely
        // when this hourly run is the only thing delivering mail. Running it
        // ahead of the sweep put a network call to Resend in front of every
        // send on the one path that could not afford it, and a maxDuration kill
        // is not catchable by withCronGuard. The alert about degraded delivery
        // could therefore consume the budget of the delivery it was reporting.
        //
        // The acknowledged cost of this order: a sweep that throws skips the
        // health check entirely. That is the cheaper loss, and it is already
        // loud via withCronGuard.
        const result = await processDueScheduledEmails();

        let watcherStale = false;
        let watcherQuietMinutes: number | null = null;
        let watcherAlerted = false;
        if (source !== "watcher") {
          const health = await checkWatcherHealth(service);
          watcherStale = health.stale;
          watcherQuietMinutes = health.quietMinutes;
          watcherAlerted = health.alerted;
        }

        return NextResponse.json({
          ...result,
          driver: source,
          ...(watcherStale ? { watcherStale, watcherQuietMinutes, watcherAlerted } : {}),
        });
      }),
    // Opt in explicitly (CAR-220). The bearer used to be honoured at the shared
    // chokepoint, which silently opened all nine QStash-verified routes,
    // including destructive sweeps and one whose body was previously bound by
    // the signature.
    { allowCronBearer: true },
  );
}
