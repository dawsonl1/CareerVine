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
  // Every .range() window the two paginated reads asked for, so a test can
  // assert the walk actually happened rather than trusting a row count that a
  // single-page fixture would satisfy either way (CAR-207).
  const bundleRanges: [number, number][] = [];
  const subRanges: [number, number][] = [];

  /** A read that paginates: .select().order().range(from, to) over `rows`. */
  const pagedRead = <T>(rows: T[], record: [number, number][], error?: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.range = (from: number, to: number) => {
      record.push([from, to]);
      if (error) return Promise.resolve({ data: null, error: { message: error } });
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    };
    return chain;
  };

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
      return pagedRead(cfg.bundles ?? [], bundleRanges, cfg.bundlesError);
    }
    if (table === "bundle_subscriptions") {
      return pagedRead(cfg.subs ?? [], subRanges);
    }
    if (table === "bundle_prospects") {
      // Thenable rather than resolving from .lte(): the unbounded case (no
      // active subscriber) deliberately omits that filter now, so a chain that
      // could only settle through .lte() would hang on exactly the shape the
      // MAX_SAFE_INTEGER bug lived in. `threshold` stays undefined there, which
      // is the assertion those tests make.
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
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) => {
        prospectDeleteCalls.push(call);
        return resolve({ count: cfg.prospectDeletes?.[call.bundleId ?? -1] ?? 0, error: null });
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  };

  return {
    service: { from } as unknown as SupabaseClient,
    discoveryDelete,
    prospectDeleteCalls,
    bundleRanges,
    subRanges,
  };
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
    // No upper bound at all, rather than a sentinel one. This used to send
    // Number.MAX_SAFE_INTEGER, which removed_in_version (int4) cannot hold:
    // PostgREST answered `value "9007199254740991" is out of range for type
    // integer` and the throw aborted the whole per-bundle loop, so a single
    // unsubscribed bundle stopped retention for every bundle after it. The old
    // version of this test asserted the sentinel, so it pinned the bug in place
    // (CAR-207, found by the integration tier).
    expect(prospectDeleteCalls[0].threshold).toBeUndefined();
    expect(result.bundleProspectsDeleted).toBe(9);
  });

  it("keeps purging the remaining bundles when one has no active subscriber", async () => {
    // The regression the sentinel caused was not local to its own bundle: the
    // throw propagated out of the loop, so every LATER bundle was skipped too.
    const { service, prospectDeleteCalls } = makeService({
      bundles: [{ id: 7 }, { id: 8 }],
      subs: [{ bundle_id: 8, synced_version: 4 }],
      prospectDeletes: { 7: 2, 8: 3 },
    });
    const result = await purgeScrapedData({ service, now: () => NOW });

    expect(result.errors).toEqual([]);
    expect(prospectDeleteCalls.map((c) => c.bundleId)).toEqual([7, 8]);
    expect(result.bundleProspectsDeleted).toBe(5);
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
      // Bundle 2 has no active subscriber, so the bound is omitted entirely.
      { bundleId: 2 },
    ]);
    expect(result.bundleProspectsDeleted).toBe(7);
  });
});
