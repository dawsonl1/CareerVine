/**
 * POST /api/cron/sync-bundles — daily QStash schedule (plan 29).
 *
 * Safety net behind the publish fan-out: finds active subscriptions that
 * are behind their bundle's committed version (missed fan-outs, applies
 * interrupted mid-loop, resubscribes) and enqueues worker jobs for them.
 * When QStash publishing isn't configured, processes a bounded batch
 * directly so correctness never depends on the queue.
 *
 * Ops: create the schedule in the Upstash console pointing at this route
 * (same as the 15-minute send-follow-ups one); daily cadence.
 */

import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { withCronGuard } from "@/lib/cron-guard";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import {
  enqueueBundleSyncJobs,
  findStaleSubscriptionIds,
  findPendingUnsubscribeIds,
  processSubscriptionsUnderBudget,
} from "@/lib/bundle-queue";

export const maxDuration = 60;

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  return withCronGuard("/api/cron/sync-bundles", () => runJob(req));
}

async function runJob(req: NextRequest): Promise<NextResponse> {
  const service = createSupabaseServiceClient();
  // Stale syncs + unfinished unsubscribe cleanups (CAR-53) — the worker
  // dispatches per row state, so one job type covers both.
  const stale = [
    ...(await findStaleSubscriptionIds(service)),
    ...(await findPendingUnsubscribeIds(service)),
  ];
  if (stale.length === 0) return NextResponse.json({ stale: 0 });

  const workerUrl = new URL("/api/queue/bundle-sync", req.url).toString();
  const enqueued = await enqueueBundleSyncJobs(stale, workerUrl);
  if (enqueued > 0) {
    return NextResponse.json({ stale: stale.length, enqueued });
  }

  // No queue available: process what fits in this invocation's budget.
  const result = await processSubscriptionsUnderBudget(service, stale);
  return NextResponse.json({
    stale: stale.length,
    processedDirectly: result.completed.length,
    remaining: result.remaining.length,
    applied: result.applied,
  });
}
