import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { purgeScrapedData, DISCOVERY_STALE_DAYS } from "@/lib/data-retention";

/**
 * purgeScrapedData (CAR-135 / R4.8): deletes stale unactioned discovery
 * candidates and soft-removed bundle prospects that every active subscriber has
 * already synced past. Both deletes are terminal, so the tests pin the exact
 * safety conditions (staleness cutoff; per-bundle min synced_version).
 */

const NOW = Date.parse("2026-07-16T12:00:00.000Z");

interface Cfg {
  staleDeleteCount?: number;
  discoveryError?: string;
  bundles?: { id: number }[];
  bundlesError?: string;
  subs?: { bundle_id: number; synced_version: number }[];
  prospectDeletes?: Record<number, number>;
}

function makeService(cfg: Cfg) {
  const discoveryDelete: { status?: string; cutoff?: string } = {};
  const prospectDeleteCalls: { bundleId?: number; threshold?: number }[] = [];

  const from = (table: string): unknown => {
    if (table === "discovery_candidates") {
      const chain: Record<string, unknown> = {};
      chain.delete = () => chain;
      chain.eq = (col: string, val: unknown) => {
        if (col === "status") discoveryDelete.status = String(val);
        return chain;
      };
      chain.lt = (_col: string, val: string) => {
        discoveryDelete.cutoff = val;
        if (cfg.discoveryError) return Promise.resolve({ count: null, error: { message: cfg.discoveryError } });
        return Promise.resolve({ count: cfg.staleDeleteCount ?? 0, error: null });
      };
      return chain;
    }
    if (table === "data_bundles") {
      return {
        select: () =>
          Promise.resolve(
            cfg.bundlesError
              ? { data: null, error: { message: cfg.bundlesError } }
              : { data: cfg.bundles ?? [], error: null },
          ),
      };
    }
    if (table === "bundle_subscriptions") {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => Promise.resolve({ data: cfg.subs ?? [], error: null });
      return chain;
    }
    if (table === "bundle_prospects") {
      const call: { bundleId?: number; threshold?: number } = {};
      const chain: Record<string, unknown> = {};
      chain.delete = () => chain;
      chain.eq = (col: string, val: unknown) => {
        if (col === "bundle_id") call.bundleId = Number(val);
        return chain;
      };
      chain.not = () => chain;
      chain.lte = (_col: string, threshold: number) => {
        call.threshold = threshold;
        prospectDeleteCalls.push(call);
        return Promise.resolve({ count: cfg.prospectDeletes?.[call.bundleId ?? -1] ?? 0, error: null });
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { service: { from } as unknown as SupabaseClient, discoveryDelete, prospectDeleteCalls };
}

describe("purgeScrapedData — discovery staleness", () => {
  it("deletes only 'new' candidates older than the staleness window", async () => {
    const { service, discoveryDelete } = makeService({ staleDeleteCount: 4, bundles: [] });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(result.discoveryStaleDeleted).toBe(4);
    expect(discoveryDelete.status).toBe("new");
    expect(discoveryDelete.cutoff).toBe(
      new Date(NOW - DISCOVERY_STALE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("records a discovery error without aborting the bundle step", async () => {
    const { service } = makeService({
      discoveryError: "boom",
      bundles: [{ id: 1 }],
      subs: [],
      prospectDeletes: { 1: 2 },
    });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(result.errors).toEqual([expect.stringContaining("discovery stale purge: boom")]);
    expect(result.bundleProspectsDeleted).toBe(2);
  });
});

describe("purgeScrapedData — bundle prospects", () => {
  it("deletes up to the minimum synced_version across active subscribers", async () => {
    const { service, prospectDeleteCalls } = makeService({
      bundles: [{ id: 1 }],
      subs: [
        { bundle_id: 1, synced_version: 8 },
        { bundle_id: 1, synced_version: 5 },
      ],
      prospectDeletes: { 1: 3 },
    });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(prospectDeleteCalls).toEqual([{ bundleId: 1, threshold: 5 }]);
    expect(result.bundleProspectsDeleted).toBe(3);
  });

  it("deletes every soft-removed row for a bundle with no active subscribers", async () => {
    const { service, prospectDeleteCalls } = makeService({
      bundles: [{ id: 7 }],
      subs: [],
      prospectDeletes: { 7: 9 },
    });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(prospectDeleteCalls[0].bundleId).toBe(7);
    expect(prospectDeleteCalls[0].threshold).toBe(Number.MAX_SAFE_INTEGER);
    expect(result.bundleProspectsDeleted).toBe(9);
  });

  it("deletes nothing for a bundle with a never-synced subscriber (synced_version 0)", async () => {
    const { service, prospectDeleteCalls } = makeService({
      bundles: [{ id: 1 }],
      subs: [{ bundle_id: 1, synced_version: 0 }],
      prospectDeletes: { 1: 3 },
    });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(prospectDeleteCalls).toEqual([]);
    expect(result.bundleProspectsDeleted).toBe(0);
  });

  it("handles multiple bundles independently", async () => {
    const { service, prospectDeleteCalls } = makeService({
      bundles: [{ id: 1 }, { id: 2 }],
      subs: [{ bundle_id: 1, synced_version: 4 }],
      prospectDeletes: { 1: 1, 2: 6 },
    });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(prospectDeleteCalls).toEqual([
      { bundleId: 1, threshold: 4 },
      { bundleId: 2, threshold: Number.MAX_SAFE_INTEGER },
    ]);
    expect(result.bundleProspectsDeleted).toBe(7);
  });
});
