/**
 * Bundle sync delivery (plan 29 §6): QStash fan-out + budgeted processing.
 *
 * Publish fan-out gives subscribers updates within minutes; the daily cron
 * safety net catches anything the fan-out missed (failed messages,
 * interrupted applies, subscriptions created between publishes). Both feed
 * the same worker route, which processes batches of subscriptions under a
 * wall-clock budget and re-enqueues what it couldn't finish.
 *
 * Publishing needs QSTASH_TOKEN. When it's absent (e.g. local dev), the
 * enqueue helpers report failure and callers fall back to direct budgeted
 * processing — correctness never depends on the queue, only latency does.
 */

import { Client } from "@upstash/qstash";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyBundleDelta,
  claimSubscriptionSync,
  releaseSubscriptionSync,
  type ApplyCursor,
  type BundleCore,
  type SubscriptionCore,
} from "./bundle-sync";

/** Subscriptions per QStash message — keeps each worker invocation's
 * failure blast radius small without a message-per-subscriber storm. */
export const FANOUT_BATCH_SIZE = 10;

/** Wall-clock budget for one worker/cron invocation (maxDuration is 60s). */
export const SYNC_BUDGET_MS = 45_000;

export interface BundleSyncJob {
  subscriptionIds: number[];
}

export function getQstashClient(): Client | null {
  const token = process.env.QSTASH_TOKEN;
  return token ? new Client({ token }) : null;
}

/**
 * Enqueue worker jobs for the given subscriptions in batches. Returns the
 * number of messages published (0 when QStash isn't configured — callers
 * then process directly or leave it to the cron).
 */
export async function enqueueBundleSyncJobs(
  subscriptionIds: number[],
  workerUrl: string,
  client: Client | null = getQstashClient(),
): Promise<number> {
  if (!client || subscriptionIds.length === 0) return 0;
  let published = 0;
  for (let i = 0; i < subscriptionIds.length; i += FANOUT_BATCH_SIZE) {
    const batch = subscriptionIds.slice(i, i + FANOUT_BATCH_SIZE);
    try {
      await client.publishJSON({
        url: workerUrl,
        body: { subscriptionIds: batch } satisfies BundleSyncJob,
        retries: 3,
        // Cap concurrent worker invocations so a large fan-out can't
        // stampede Supabase.
        flowControl: { key: "bundle-sync", parallelism: 2 },
      });
      published++;
    } catch (err) {
      console.error("[bundle-queue] Failed to enqueue sync job:", err);
    }
  }
  return published;
}

/** Active subscriptions of a bundle that are behind its committed version. */
export async function findStaleSubscriptionIds(
  service: SupabaseClient,
  opts: { bundleId?: number; limit?: number } = {},
): Promise<number[]> {
  // users!inner skips suspended accounts — their subscriptions stay stale
  // (held) and resume syncing when the account is reactivated.
  let query = service
    .from("bundle_subscriptions")
    .select("id, synced_version, data_bundles!inner(version, status), users!inner(status)")
    .eq("status", "active")
    .eq("data_bundles.status", "published")
    .eq("users.status", "active")
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(opts.limit ?? 500);
  if (opts.bundleId) query = query.eq("bundle_id", opts.bundleId);
  const { data } = await query;
  return (
    (data as Array<{ id: number; synced_version: number; data_bundles: { version: number } }> | null) ?? []
  )
    .filter((r) => r.synced_version < r.data_bundles.version)
    .map((r) => r.id);
}

// ── Budgeted processing ────────────────────────────────────────────────

export interface ProcessDeps {
  apply: typeof applyBundleDelta;
  claim: typeof claimSubscriptionSync;
  release: typeof releaseSubscriptionSync;
  now: () => number;
}

export interface ProcessResult {
  completed: number[];
  /** Not finished within budget — re-enqueue these. */
  remaining: number[];
  /** Claimed by another driver — nothing to do here. */
  skipped: number[];
  applied: number;
}

/**
 * Process subscriptions serially under a wall-clock budget on the
 * service-role client. Every query inside applyBundleDelta is scoped by
 * the subscription's user_id — same discipline as the gmail cron.
 */
export async function processSubscriptionsUnderBudget(
  service: SupabaseClient,
  subscriptionIds: number[],
  budgetMs: number = SYNC_BUDGET_MS,
  deps: Partial<ProcessDeps> = {},
): Promise<ProcessResult> {
  const d: ProcessDeps = {
    apply: deps.apply ?? applyBundleDelta,
    claim: deps.claim ?? claimSubscriptionSync,
    release: deps.release ?? releaseSubscriptionSync,
    now: deps.now ?? Date.now,
  };
  const deadline = d.now() + budgetMs;
  const result: ProcessResult = { completed: [], remaining: [], skipped: [], applied: 0 };
  if (subscriptionIds.length === 0) return result;

  const { data: rows } = await service
    .from("bundle_subscriptions")
    .select("id, user_id, bundle_id, status, synced_version, data_bundles!inner(id, slug, name, version, status)")
    .in("id", subscriptionIds)
    .eq("status", "active");
  const subs = (rows as Array<SubscriptionCore & { data_bundles: BundleCore & { status: string } }> | null) ?? [];
  const byId = new Map(subs.map((s) => [s.id, s]));

  for (let i = 0; i < subscriptionIds.length; i++) {
    const id = subscriptionIds[i];
    const sub = byId.get(id);
    if (!sub || sub.data_bundles.status !== "published" || sub.synced_version >= sub.data_bundles.version) {
      result.completed.push(id); // nothing to do (unsubscribed, unpublished, or current)
      continue;
    }
    if (d.now() >= deadline) {
      result.remaining.push(...subscriptionIds.slice(i));
      break;
    }

    let token = await d.claim(service, id, null);
    if (!token) {
      result.skipped.push(id);
      continue;
    }

    const bundle: BundleCore = {
      id: sub.data_bundles.id,
      slug: sub.data_bundles.slug,
      name: sub.data_bundles.name,
      version: sub.data_bundles.version,
    };
    const pinnedVersion = bundle.version;
    let cursor: ApplyCursor | null = null;
    let finished = false;

    try {
      while (d.now() < deadline) {
        const step = await d.apply(service, sub, bundle, { cursor, pinnedVersion });
        result.applied += step.applied;
        if (step.done) {
          finished = true;
          break;
        }
        cursor = step.nextCursor;
        const renewed = await d.claim(service, id, token);
        if (!renewed) break; // lost the claim — back off
        token = renewed;
      }
    } finally {
      await d.release(service, id, token).catch(() => {});
    }

    if (finished) result.completed.push(id);
    else {
      // Ran out of budget (or lost the claim) mid-subscription: everything
      // from here re-enqueues; synced_version only advances on completion,
      // so resuming is idempotent.
      result.remaining.push(...subscriptionIds.slice(i));
      break;
    }
  }

  return result;
}
