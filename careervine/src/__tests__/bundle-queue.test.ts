import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Client } from '@upstash/qstash';
import {
  enqueueBundleSyncJobs,
  findStaleSubscriptionIds,
  processSubscriptionsUnderBudget,
  FANOUT_BATCH_SIZE,
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
    select: () => builder, eq: () => builder, in: () => builder,
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
});
