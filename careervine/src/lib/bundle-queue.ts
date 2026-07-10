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
  readSyncCheckpoint,
  unsubscribeFromBundle,
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
  opts: { delaySeconds?: number } = {},
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
        ...(opts.delaySeconds ? { delay: opts.delaySeconds } : {}),
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

/** Unsubscribed rows whose removal loop never finished (CAR-53) — the
 * unsubscribe_keep_all intent stays set until cleanup completes, so the
 * cron can sweep strays even when the backup QStash job was lost. */
export async function findPendingUnsubscribeIds(
  service: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<number[]> {
  const { data } = await service
    .from("bundle_subscriptions")
    .select("id, users!inner(status)")
    .eq("status", "unsubscribed")
    .not("unsubscribe_keep_all", "is", null)
    .eq("users.status", "active")
    .limit(opts.limit ?? 500);
  return ((data as Array<{ id: number }> | null) ?? []).map((r) => r.id);
}

// ── Budgeted processing ────────────────────────────────────────────────

export interface ProcessDeps {
  apply: typeof applyBundleDelta;
  claim: typeof claimSubscriptionSync;
  release: typeof releaseSubscriptionSync;
  unsubscribe: typeof unsubscribeFromBundle;
  now: () => number;
}

export interface ProcessResult {
  completed: number[];
  /** Not finished within budget — re-enqueue these. */
  remaining: number[];
  /** Claimed by another driver — nothing to do here. */
  skipped: number[];
  applied: number;
  /** Contacts removed by resumed unsubscribe cleanups (CAR-53). */
  removed: number;
}

/**
 * Process subscriptions serially under a wall-clock budget on the
 * service-role client. Every query inside applyBundleDelta is scoped by
 * the subscription's user_id — same discipline as the gmail cron.
 *
 * Dispatches per row state: active-and-stale rows sync (resuming from the
 * persisted sync_cursor checkpoint when present — CAR-54); unsubscribed
 * rows with a pending unsubscribe_keep_all intent resume their removal
 * loop (CAR-53); everything else is already done.
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
    unsubscribe: deps.unsubscribe ?? unsubscribeFromBundle,
    now: deps.now ?? Date.now,
  };
  const deadline = d.now() + budgetMs;
  const result: ProcessResult = { completed: [], remaining: [], skipped: [], applied: 0, removed: 0 };
  if (subscriptionIds.length === 0) return result;

  type Row = SubscriptionCore & {
    sync_cursor: unknown;
    unsubscribe_keep_all: boolean | null;
    data_bundles: (BundleCore & { status: string }) | null;
  };
  const { data: rows } = await service
    .from("bundle_subscriptions")
    .select(
      "id, user_id, bundle_id, status, synced_version, sync_cursor, unsubscribe_keep_all, data_bundles(id, slug, name, version, status)",
    )
    .in("id", subscriptionIds);
  const byId = new Map(((rows as Row[] | null) ?? []).map((s) => [s.id, s]));

  for (let i = 0; i < subscriptionIds.length; i++) {
    const id = subscriptionIds[i];
    const sub = byId.get(id);
    if (d.now() >= deadline) {
      result.remaining.push(...subscriptionIds.slice(i));
      break;
    }

    // ── Pending unsubscribe cleanup (CAR-53) ──
    if (sub && sub.status === "unsubscribed" && sub.unsubscribe_keep_all != null) {
      // No claim: the status flip already fences out sync drivers, and the
      // removal loop is idempotent (deterministic decisions, delete-by-id) —
      // matching the client-driven unsubscribe, which never claimed either.
      let cursor: number | null = null;
      let finished = false;
      while (d.now() < deadline) {
        const step = await d.unsubscribe(service, sub, { keepAll: sub.unsubscribe_keep_all, cursor });
        result.removed += step.removed;
        if (step.done) {
          finished = true;
          break;
        }
        cursor = step.nextCursor;
      }
      if (finished) result.completed.push(id);
      else {
        result.remaining.push(...subscriptionIds.slice(i));
        break;
      }
      continue;
    }

    if (
      !sub ||
      sub.status !== "active" ||
      !sub.data_bundles ||
      sub.data_bundles.status !== "published" ||
      sub.synced_version >= sub.data_bundles.version
    ) {
      result.completed.push(id); // nothing to do (finished unsubscribe, unpublished, or current)
      continue;
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
    // Resume an interrupted sync from its persisted checkpoint (CAR-54):
    // the stored pin keeps the resumed loop on the version it started
    // against; a later publish is picked up by the next stale-scan.
    const checkpoint = readSyncCheckpoint(sub.sync_cursor, sub.synced_version);
    const pinnedVersion = checkpoint?.pinnedVersion ?? bundle.version;
    let cursor: ApplyCursor | null = checkpoint ? { phase: checkpoint.phase, afterId: checkpoint.afterId } : null;
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

    // A resumed pin can be behind the bundle's current version — completing
    // it is progress, but the subscription may still be stale, so only count
    // it done when it reached the live version.
    if (finished && pinnedVersion >= bundle.version) result.completed.push(id);
    else if (finished) result.remaining.push(id);
    else {
      // Ran out of budget (or lost the claim) mid-subscription: everything
      // from here re-enqueues; the persisted checkpoint (CAR-54) makes the
      // next invocation resume instead of re-scanning from chunk 0.
      result.remaining.push(...subscriptionIds.slice(i));
      break;
    }
  }

  return result;
}
