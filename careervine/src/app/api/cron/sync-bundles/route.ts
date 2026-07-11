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
import { resolveBundleChunk, markBundleResolved } from "@/lib/bundle-resolve";
import type { SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 60;

/** Time slice for the resolver self-heal — the sync work below still needs
 * most of the 60s window. Normally a no-op (the publish script resolves);
 * a bundle it can't finish stays unresolved and simply keeps taking the
 * merge path until tomorrow's run continues from where the hashes left off. */
const RESOLVE_BUDGET_MS = 25_000;

/** Self-heal (CAR-62): any published bundle whose committed version was never
 * snapshot-resolved (crashed publish script, manual finalize) gets resolved
 * here, before the stale scan, so today's fan-out already benefits. */
async function resolveStaleBundles(service: SupabaseClient): Promise<number> {
  const deadline = Date.now() + RESOLVE_BUDGET_MS;
  const { data } = await service
    .from("data_bundles")
    .select("id, slug, version, resolved_version")
    .eq("status", "published")
    .gt("version", 0);
  const bundles = ((data as Array<{ id: number; slug: string; version: number; resolved_version: number }> | null) ?? [])
    .filter((b) => b.resolved_version < b.version);

  let resolved = 0;
  for (const bundle of bundles) {
    let afterId = 0;
    for (;;) {
      if (Date.now() >= deadline) return resolved;
      const step = await resolveBundleChunk(service, bundle, { afterId });
      resolved += step.resolved;
      if (step.done) {
        await markBundleResolved(service, bundle);
        break;
      }
      afterId = step.nextAfterId ?? 0;
    }
  }
  return resolved;
}

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

  // Resolution self-heal first: never throws the job — sync must still run.
  let resolvedProspects = 0;
  try {
    resolvedProspects = await resolveStaleBundles(service);
  } catch (err) {
    console.error("[sync-bundles] resolver self-heal failed:", err);
  }

  // Stale syncs + unfinished unsubscribe cleanups (CAR-53) — the worker
  // dispatches per row state, so one job type covers both.
  const stale = [
    ...(await findStaleSubscriptionIds(service)),
    ...(await findPendingUnsubscribeIds(service)),
  ];
  if (stale.length === 0) return NextResponse.json({ stale: 0, resolvedProspects });

  const workerUrl = new URL("/api/queue/bundle-sync", req.url).toString();
  const enqueued = await enqueueBundleSyncJobs(stale, workerUrl);
  if (enqueued > 0) {
    return NextResponse.json({ stale: stale.length, enqueued, resolvedProspects });
  }

  // No queue available: process what fits in this invocation's budget.
  const result = await processSubscriptionsUnderBudget(service, stale);
  return NextResponse.json({
    stale: stale.length,
    processedDirectly: result.completed.length,
    remaining: result.remaining.length,
    applied: result.applied,
    resolvedProspects,
  });
}
