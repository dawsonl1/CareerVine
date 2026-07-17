/**
 * CAR-81: the sync-bundles cron self-drains a resolve backlog. When a run
 * makes forward progress but a bundle is still behind, it re-enqueues one more
 * run so a fresh publish's thousands of unresolved rows clear in minutes
 * instead of one 200-row chunk per daily cron. Progress-gated so a stuck
 * bundle can't loop; self-terminates once caught up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResolveChunkResult } from "@/lib/bundle-resolve";

const resolveChunkMock = vi.fn<(...a: unknown[]) => Promise<ResolveChunkResult>>();
const markResolvedMock = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/lib/bundle-resolve", () => ({
  resolveBundleChunk: (...a: unknown[]) => resolveChunkMock(...a),
  markBundleResolved: (...a: unknown[]) => markResolvedMock(...a),
}));

const enqueueDrainMock = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/lib/bundle-queue", () => ({
  enqueueResolveDrain: (...a: unknown[]) => enqueueDrainMock(...a),
  enqueueBundleSyncJobs: vi.fn(async () => 0),
  findStaleSubscriptionIds: vi.fn(async () => []),
  findPendingUnsubscribeIds: vi.fn(async () => []),
  processSubscriptionsUnderBudget: vi.fn(async () => ({ completed: [], remaining: [], applied: 0 })),
  SYNC_RESPONSE_DEADLINE_MS: 55_000,
}));

vi.mock("@/lib/cron-guard", () => ({
  withCronGuard: (_name: string, fn: () => unknown) => fn(),
}));

vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify() {
      return Promise.resolve(true);
    }
  },
}));

// Only data_bundles is read directly by the route (resolveStaleBundles); the
// rest is mocked above. from().select().eq().gt().order() resolves to bundles.
let bundlesData: unknown[] = [];
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        gt: () => b,
        order: () => Promise.resolve({ data: bundlesData }),
      });
      return b;
    },
  }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/cron/sync-bundles/route";

const step = (p: Partial<ResolveChunkResult>): ResolveChunkResult => ({
  done: false,
  nextAfterId: 200,
  scanned: 200,
  resolved: 0,
  skipped: [],
  ...p,
});

function req() {
  return new NextRequest("https://www.careervine.app/api/cron/sync-bundles", {
    method: "POST",
    headers: { "upstash-signature": "sig", "content-type": "application/json" },
    body: "{}",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
  resolveChunkMock.mockReset();
  markResolvedMock.mockClear();
  enqueueDrainMock.mockClear();
  enqueueDrainMock.mockResolvedValue(true);
  bundlesData = [];
});
afterEach(() => vi.useRealTimers());

describe("sync-bundles resolve self-drain (CAR-81)", () => {
  it("re-enqueues when it made progress but a bundle is still behind", async () => {
    bundlesData = [{ id: 1, slug: "apm", version: 4, resolved_version: 0 }];
    // Resolve one chunk, then blow the 12s budget so the bundle stays behind.
    resolveChunkMock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 13_000);
      return step({ resolved: 200, done: false });
    });

    const res = await POST(req());
    const body = await res.json();

    expect(enqueueDrainMock).toHaveBeenCalledTimes(1);
    expect(enqueueDrainMock.mock.calls[0][0]).toBe(
      "https://www.careervine.app/api/cron/sync-bundles",
    );
    expect(body.resolvedProspects).toBe(200);
    expect(body.drained).toBe(true);
  });

  it("does NOT re-enqueue when the run made zero progress (stuck bundle can't loop)", async () => {
    bundlesData = [{ id: 1, slug: "apm", version: 4, resolved_version: 0 }];
    resolveChunkMock.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 13_000);
      return step({ resolved: 0, done: false });
    });

    const res = await POST(req());
    const body = await res.json();

    expect(enqueueDrainMock).not.toHaveBeenCalled();
    expect(body.drained).toBe(false);
  });

  it("does NOT re-enqueue once the bundle is fully resolved this run", async () => {
    bundlesData = [{ id: 1, slug: "apm", version: 4, resolved_version: 0 }];
    resolveChunkMock.mockResolvedValueOnce(step({ resolved: 200, done: true, nextAfterId: null }));

    const res = await POST(req());

    expect(markResolvedMock).toHaveBeenCalledTimes(1);
    expect(enqueueDrainMock).not.toHaveBeenCalled();
    expect((await res.json()).drained).toBe(false);
  });

  it("does nothing when every published bundle is already caught up", async () => {
    bundlesData = [{ id: 1, slug: "apm", version: 4, resolved_version: 4 }];

    await POST(req());

    expect(resolveChunkMock).not.toHaveBeenCalled();
    expect(enqueueDrainMock).not.toHaveBeenCalled();
  });
});
