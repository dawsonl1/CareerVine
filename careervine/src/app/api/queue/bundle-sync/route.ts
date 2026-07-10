/**
 * POST /api/queue/bundle-sync — QStash-signed bundle sync worker (plan 29).
 *
 * Receives { subscriptionIds } batches from the publish fan-out or the
 * daily cron, processes them under a wall-clock budget on the service
 * client, and re-enqueues whatever it couldn't finish. Serialization
 * claims make it safe alongside the user-driven apply loop.
 */

import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { enqueueBundleSyncJobs, processSubscriptionsUnderBudget } from "@/lib/bundle-queue";
import { SYNC_CLAIM_MS } from "@/lib/bundle-sync";

export const maxDuration = 60;

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
});

export async function POST(req: NextRequest) {
  let bodyText: string;
  try {
    bodyText = await req.text();
    const signature = req.headers.get("upstash-signature") || "";
    await receiver.verify({ body: bodyText, signature, url: req.url });
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

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
  const result = await processSubscriptionsUnderBudget(service, subscriptionIds);

  let requeued = 0;
  if (result.remaining.length > 0) {
    requeued = await enqueueBundleSyncJobs(result.remaining, req.url);
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
    retriedSkipped = await enqueueBundleSyncJobs(result.skipped, req.url, undefined, {
      delaySeconds: Math.ceil(SYNC_CLAIM_MS / 1000) + 60,
    });
  }

  return NextResponse.json({
    completed: result.completed.length,
    skipped: result.skipped.length,
    remaining: result.remaining.length,
    requeued,
    retriedSkipped,
    applied: result.applied,
  });
}
