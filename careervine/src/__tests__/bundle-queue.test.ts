import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client } from '@upstash/qstash';
import {
  enqueueBundleSyncJobs,
  enqueueResolveDrain,
  findStaleSubscriptionIds,
  findPendingUnsubscribeIds,
  processSubscriptionsUnderBudget,
  FANOUT_BATCH_SIZE,
  SYNC_BUDGET_MS,
} from '@/lib/bundle-queue';
import type { ApplyStepResult } from '@/lib/bundle-sync';

// ── Fixtures ───────────────────────────────────────────────────────────

function subRow(id: number, syncedVersion = 0, bundleVersion = 3) {
  return {
    id,
    user_id: `user-${id}`,
    bundle_id: 9,
    status: 'active',
    synced_version: syncedVersion,
    data_bundles: { id: 9, slug: 'ib-banks', name: 'IB Banks', version: bundleVersion, status: 'published' },
  };
}

function mockService(rows: unknown[]): SupabaseClient {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder, eq: () => builder, in: () => builder, not: () => builder,
    order: () => builder, limit: () => builder,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  });
  return { from: () => builder } as unknown as SupabaseClient;
}

const stepDone = (applied = 1): ApplyStepResult => ({
  done: true, nextCursor: null, pinnedVersion: 3, applied, removedContacts: 0, orphanedLinks: 0, skipped: [],
});
const stepMore = (afterId: number): ApplyStepResult => ({
  done: false, nextCursor: { phase: 'apply', afterId }, pinnedVersion: 3, applied: 1,
  removedContacts: 0, orphanedLinks: 0, skipped: [],
});

// ── enqueueBundleSyncJobs ──────────────────────────────────────────────

describe('enqueueBundleSyncJobs', () => {
  it('batches subscriptions per message with flow control', async () => {
    const publishJSON = vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const client = { publishJSON } as unknown as Client;
    const ids = Array.from({ length: FANOUT_BATCH_SIZE + 5 }, (_, i) => i + 1);
    const published = await enqueueBundleSyncJobs(ids, 'https://x/api/queue/bundle-sync', client);
    expect(published).toBe(2);
    expect(publishJSON.mock.calls[0][0]).toMatchObject({
      url: 'https://x/api/queue/bundle-sync',
      body: { subscriptionIds: ids.slice(0, FANOUT_BATCH_SIZE) },
      flowControl: { key: 'bundle-sync', parallelism: 2 },
    });
    expect(publishJSON.mock.calls[1][0]).toMatchObject({ body: { subscriptionIds: ids.slice(FANOUT_BATCH_SIZE) } });
  });

  it('returns 0 without a client (QStash unconfigured) or with no ids', async () => {
    expect(await enqueueBundleSyncJobs([1, 2], 'https://x', null)).toBe(0);
    const publishJSON = vi.fn(async () => ({}));
    expect(await enqueueBundleSyncJobs([], 'https://x', { publishJSON } as unknown as Client)).toBe(0);
    expect(publishJSON).not.toHaveBeenCalled();
  });
});

// ── enqueueResolveDrain (CAR-81) ───────────────────────────────────────

describe('enqueueResolveDrain', () => {
  it('publishes a delayed self-drain to the cron url with single-parallelism flow control', async () => {
    const publishJSON = vi.fn<(msg: Record<string, unknown>) => Promise<unknown>>(async () => ({}));
    const ok = await enqueueResolveDrain('https://x/api/cron/sync-bundles', { publishJSON } as unknown as Client, {
      delaySeconds: 3,
    });
    expect(ok).toBe(true);
    expect(publishJSON.mock.calls[0][0]).toMatchObject({
      url: 'https://x/api/cron/sync-bundles',
      body: {},
      delay: 3,
      flowControl: { key: 'sync-bundles-drain', parallelism: 1 },
    });
  });

  it('is a no-op (false) when QStash is unconfigured', async () => {
    expect(await enqueueResolveDrain('https://x', null)).toBe(false);
  });

  it('returns false and swallows a publish failure', async () => {
    const publishJSON = vi.fn(async () => {
      throw new Error('qstash down');
    });
    expect(await enqueueResolveDrain('https://x', { publishJSON } as unknown as Client)).toBe(false);
  });
});

// ── findStaleSubscriptionIds ───────────────────────────────────────────

describe('findStaleSubscriptionIds', () => {
  it('returns only subscriptions behind their bundle version', async () => {
    const service = mockService([
      { id: 1, synced_version: 3, data_bundles: { version: 3 } },
      { id: 2, synced_version: 1, data_bundles: { version: 3 } },
      { id: 3, synced_version: 0, data_bundles: { version: 2 } },
    ]);
    expect(await findStaleSubscriptionIds(service)).toEqual([2, 3]);
  });
});

// ── processSubscriptionsUnderBudget ────────────────────────────────────

describe('processSubscriptionsUnderBudget', () => {
  it('claims, loops chunks to done, releases, and reports applied counts', async () => {
    const apply = vi.fn()
      .mockResolvedValueOnce(stepMore(100))
      .mockResolvedValueOnce(stepDone());
    const claim = vi.fn(async () => 'token');
    const release = vi.fn(async () => {});
    const result = await processSubscriptionsUnderBudget(mockService([subRow(1)]), [1], 45_000, {
      apply, claim, release,
    });
    expect(result.completed).toEqual([1]);
    expect(result.applied).toBe(2);
    expect(apply).toHaveBeenCalledTimes(2);
    // Renewal CAS uses the prior token
    expect(claim).toHaveBeenNthCalledWith(2, expect.anything(), 1, 'token');
    expect(release).toHaveBeenCalledOnce();
  });

  it('skips subscriptions already claimed by another driver', async () => {
    const apply = vi.fn();
    const claim = vi.fn(async () => null);
    const result = await processSubscriptionsUnderBudget(mockService([subRow(1)]), [1], 45_000, {
      apply, claim, release: vi.fn(async () => {}),
    });
    expect(result.skipped).toEqual([1]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('treats already-current and inactive subscriptions as completed no-ops', async () => {
    const apply = vi.fn();
    const result = await processSubscriptionsUnderBudget(
      mockService([subRow(1, 3, 3)]), // synced == version
      [1, 999], // 999 not returned by the query (unsubscribed)
      45_000,
      { apply, claim: vi.fn(), release: vi.fn() },
    );
    expect(result.completed).toEqual([1, 999]);
    expect(apply).not.toHaveBeenCalled();
  });

  it('stops at the budget and re-enqueues the rest, releasing the claim', async () => {
    let clock = 0;
    const apply = vi.fn(async () => {
      clock += 30_000;
      return stepMore(clock); // never finishes
    });
    const claim = vi.fn(async () => 'token');
    const release = vi.fn(async () => {});
    const result = await processSubscriptionsUnderBudget(
      mockService([subRow(1), subRow(2)]),
      [1, 2],
      45_000,
      { apply, claim, release, now: () => clock },
    );
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual([1, 2]); // interrupted sub + untouched rest
    expect(release).toHaveBeenCalledOnce();
  });

  it('pins the version for the whole subscription loop', async () => {
    const apply = vi.fn<(...args: unknown[]) => Promise<ApplyStepResult>>(async () => stepDone());
    await processSubscriptionsUnderBudget(mockService([subRow(1, 0, 7)]), [1], 45_000, {
      apply, claim: vi.fn(async () => 't'), release: vi.fn(async () => {}),
    });
    expect(apply.mock.calls[0][3]).toMatchObject({ pinnedVersion: 7 });
  });

  it('resumes an interrupted sync from its persisted checkpoint (CAR-54)', async () => {
    const apply = vi.fn<(...args: unknown[]) => Promise<ApplyStepResult>>(async () => stepDone());
    const row = { ...subRow(1, 0, 3), sync_cursor: { phase: 'remove', afterId: 120, pinnedVersion: 3 } };
    const result = await processSubscriptionsUnderBudget(mockService([row]), [1], 45_000, {
      apply, claim: vi.fn(async () => 't'), release: vi.fn(async () => {}),
    });
    expect(apply.mock.calls[0][3]).toMatchObject({
      cursor: { phase: 'remove', afterId: 120 },
      pinnedVersion: 3,
    });
    expect(result.completed).toEqual([1]);
  });

  it('ignores a stale checkpoint whose pin is already committed', async () => {
    const apply = vi.fn<(...args: unknown[]) => Promise<ApplyStepResult>>(async () => stepDone());
    const row = { ...subRow(1, 2, 3), sync_cursor: { phase: 'apply', afterId: 50, pinnedVersion: 2 } };
    await processSubscriptionsUnderBudget(mockService([row]), [1], 45_000, {
      apply, claim: vi.fn(async () => 't'), release: vi.fn(async () => {}),
    });
    expect(apply.mock.calls[0][3]).toMatchObject({ cursor: null, pinnedVersion: 3 });
  });

  it('re-enqueues a subscription whose resumed pin finished behind the live version', async () => {
    const apply = vi.fn<(...args: unknown[]) => Promise<ApplyStepResult>>(async () => stepDone());
    // Checkpoint pinned v3; the bundle has since published v5 — completing
    // the resumed pin is progress, but the row is still stale.
    const row = { ...subRow(1, 0, 5), sync_cursor: { phase: 'apply', afterId: 50, pinnedVersion: 3 } };
    const result = await processSubscriptionsUnderBudget(mockService([row]), [1], 45_000, {
      apply, claim: vi.fn(async () => 't'), release: vi.fn(async () => {}),
    });
    expect(apply.mock.calls[0][3]).toMatchObject({ pinnedVersion: 3 });
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual([1]);
  });

  it('resumes a pending unsubscribe cleanup without claiming (CAR-53)', async () => {
    const unsubscribe = vi.fn()
      .mockResolvedValueOnce({ done: false, nextCursor: 50, removed: 3, kept: 1 })
      .mockResolvedValueOnce({ done: true, nextCursor: null, removed: 2, kept: 0 });
    const claim = vi.fn(async () => 't');
    const apply = vi.fn();
    const row = { ...subRow(1), status: 'unsubscribed', unsubscribe_keep_all: false };
    const result = await processSubscriptionsUnderBudget(mockService([row]), [1], 45_000, {
      apply, claim, release: vi.fn(async () => {}), unsubscribe,
    });
    expect(result.completed).toEqual([1]);
    expect(result.removed).toBe(5);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe.mock.calls[0][2]).toMatchObject({ keepAll: false, cursor: null });
    expect(unsubscribe.mock.calls[1][2]).toMatchObject({ keepAll: false, cursor: 50 });
    expect(apply).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('treats a finished unsubscribe (intent cleared) as a completed no-op', async () => {
    const unsubscribe = vi.fn();
    const row = { ...subRow(1), status: 'unsubscribed', unsubscribe_keep_all: null };
    const result = await processSubscriptionsUnderBudget(mockService([row]), [1], 45_000, {
      apply: vi.fn(), claim: vi.fn(), release: vi.fn(), unsubscribe,
    });
    expect(result.completed).toEqual([1]);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('isolates a throwing subscription: reports it failed, releases its claim, keeps going, never rejects (CAR-106)', async () => {
    // A merge-path throw on sub 1 must not reject the whole call — that would
    // 500 the worker and QStash would retry the entire batch 3×.
    const apply = vi.fn()
      .mockRejectedValueOnce(new Error('merge-path linkage failure'))
      .mockResolvedValueOnce(stepDone());
    const claim = vi.fn(async () => 'token');
    const release = vi.fn(async () => {});
    const result = await processSubscriptionsUnderBudget(
      mockService([subRow(1), subRow(2)]),
      [1, 2],
      45_000,
      { apply, claim, release },
    );
    expect(result.failed).toEqual([1]);
    expect(result.completed).toEqual([2]); // the rest still processes
    expect(result.remaining).toEqual([]); // failed is NOT re-enqueued
    expect(release).toHaveBeenCalledTimes(2); // claim released even on throw
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('defaults the budget to SYNC_BUDGET_MS = 35_000 (CAR-112: a full worst-case step under the 60s maxDuration)', () => {
    expect(SYNC_BUDGET_MS).toBe(35_000);
  });

  it('uses SYNC_BUDGET_MS as the default budget: a clock past it re-enqueues all (CAR-112)', async () => {
    // now() → 0 when the deadline is computed, then jumps to the budget on the
    // first per-subscription check, so nothing starts and all rows re-enqueue.
    const seq = [0, SYNC_BUDGET_MS];
    let i = 0;
    const now = () => seq[Math.min(i++, seq.length - 1)];
    const apply = vi.fn();
    const result = await processSubscriptionsUnderBudget(
      mockService([subRow(1), subRow(2)]),
      [1, 2],
      undefined, // exercise the default budget
      { apply, claim: vi.fn(async () => 't'), release: vi.fn(async () => {}), now },
    );
    expect(result.remaining).toEqual([1, 2]);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('findPendingUnsubscribeIds', () => {
  it('returns ids from the pending-unsubscribe sweep', async () => {
    const service = mockService([{ id: 7 }, { id: 9 }]);
    expect(await findPendingUnsubscribeIds(service)).toEqual([7, 9]);
  });
});
