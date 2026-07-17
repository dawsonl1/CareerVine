/**
 * POST /api/queue/bundle-sync — QStash-signed bundle sync worker (plan 29).
 *
 * Receives { subscriptionIds } batches from the publish fan-out or the
 * daily cron, processes them under a wall-clock budget on the service
 * client, and re-enqueues whatever it couldn't finish. Serialization
 * claims make it safe alongside the user-driven apply loop.
 */

import { NextRequest, NextResponse } from "next/server";
import { withQStashVerification } from "@/lib/qstash-verify";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { enqueueBundleSyncJobs, processSubscriptionsUnderBudget, SYNC_RESPONSE_DEADLINE_MS } from "@/lib/bundle-queue";
import { SYNC_CLAIM_MS } from "@/lib/bundle-sync";
import { runWithResponseDeadline } from "@/lib/time-budget";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  return withQStashVerification(req, async (bodyText) => {
    let subscriptionIds: number[];
    try {
      const parsed = JSON.parse(bodyText) as { subscriptionIds?: unknown };
      subscriptionIds = Array.isArray(parsed.subscriptionIds)
        ? parsed.subscriptionIds.filter((id): id is number => Number.isInteger(id))
        : [];
    } catch {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    if (subscriptionIds.length === 0) return NextResponse.json({ processed: 0 });

    const service = createSupabaseServiceClient();

    // Hard backstop (CAR-112): the processor's budget gates STARTING a chunk but
    // can't interrupt one in flight, so a slow chunk started near the edge could
    // overrun maxDuration and get hard-killed mid-write — which skips the graceful
    // re-enqueue in processBatch and makes QStash retry the whole batch 3×. Race
    // the processing against a wall-clock deadline; if it wins, re-enqueue the
    // whole input batch (idempotent — completed subs no-op next run) and return
    // 200. One clean re-enqueue instead of a batch-wide retry storm.
    return runWithResponseDeadline<NextResponse>(
      SYNC_RESPONSE_DEADLINE_MS - (Date.now() - startedAt),
      processBatch(service, subscriptionIds, req.url),
      async () => {
        const requeued = await enqueueBundleSyncJobs(subscriptionIds, req.url);
        if (requeued === 0) {
          console.warn(
            `[bundle-sync] Response-deadline backstop hit and re-enqueue unavailable for ${subscriptionIds.length} subscription(s)`,
          );
        }
        return NextResponse.json({ timedOut: true, requeued });
      },
    );
  });
}

/** Process one batch under the cooperative budget and re-enqueue whatever it
 * couldn't finish. Wrapped by the response-deadline backstop in POST. */
async function processBatch(
  service: ReturnType<typeof createSupabaseServiceClient>,
  subscriptionIds: number[],
  workerUrl: string,
): Promise<NextResponse> {
  const result = await processSubscriptionsUnderBudget(service, subscriptionIds);

  let requeued = 0;
  if (result.remaining.length > 0) {
    requeued = await enqueueBundleSyncJobs(result.remaining, workerUrl);
    if (requeued === 0) {
      // Queue unavailable — the daily cron will pick these up.
      console.warn(`[bundle-sync] Could not re-enqueue ${result.remaining.length} subscriptions`);
    }
  }

  // Skipped = another driver held the claim. If that driver was a
  // timeout-killed apply call, its claim is a zombie that only lapses with
  // SYNC_CLAIM_MS — retry after the window instead of stranding the
  // subscription until the daily cron (CAR-47). A healthy driver finishing
  // in the meantime makes the retried job a no-op (synced_version current),
  // so the chain terminates.
  let retriedSkipped = 0;
  if (result.skipped.length > 0) {
    retriedSkipped = await enqueueBundleSyncJobs(result.skipped, workerUrl, undefined, {
      delaySeconds: Math.ceil(SYNC_CLAIM_MS / 1000) + 60,
    });
  }

  // Failed = threw mid-processing (CAR-106). Deliberately NOT re-enqueued —
  // the daily stale-scan re-picks them up clean, so a deterministically-broken
  // subscription can't hot-loop the queue. Reported for observability.
  if (result.failed.length > 0) {
    console.warn(`[bundle-sync] ${result.failed.length} subscription(s) failed and were dropped: ${result.failed.join(", ")}`);
  }

  return NextResponse.json({
    completed: result.completed.length,
    skipped: result.skipped.length,
    remaining: result.remaining.length,
    failed: result.failed.length,
    requeued,
    retriedSkipped,
    applied: result.applied,
  });
}
