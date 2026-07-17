import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  beginPublish,
  publishProspectsChunk,
  publishCompaniesChunk,
  finalizePublish,
  hashPayload,
  stableStringify,
  BundlePublishError,
} from '@/lib/bundle-publish';
import { bundleProspectPayloadV1Schema } from '@/lib/bundle-payload';
import { isAuthorizedAdminToken } from '@/lib/admin-auth';

vi.mock('@/lib/company-helpers', () => ({
  findOrCreateCompany: vi.fn(async () => ({ id: 500, name: 'Goldman Sachs' })),
  findOrCreateLocation: vi.fn(async () => ({ id: 600 })),
  ensureCompanyLocation: vi.fn(async () => undefined),
}));

// ── Programmable chained-builder mock ──────────────────────────────────
// handler(state) decides each query's response; every issued query is
// recorded in `calls` for assertions.

interface QueryState {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
  count?: boolean;
}

type Responder = (state: QueryState) => { data?: unknown; error?: { message: string } | null; count?: number | null };

function createMockService(respond: Responder) {
  const calls: QueryState[] = [];

  function makeBuilder(table: string) {
    const state: QueryState = { table, op: 'select', filters: [] };
    calls.push(state);
    const resolve = () => {
      const r = respond(state) ?? {};
      return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
    };
    const builder: Record<string, unknown> = {};
    const chain = (method: string) =>
      (...args: unknown[]) => {
        state.filters.push({ method, args });
        return builder;
      };
    Object.assign(builder, {
      select(fields?: string, opts?: { count?: string }) {
        if (opts?.count) state.count = true;
        state.filters.push({ method: 'select', args: [fields] });
        return builder;
      },
      insert(payload: unknown) { state.op = 'insert'; state.payload = payload; return builder; },
      update(payload: unknown) { state.op = 'update'; state.payload = payload; return builder; },
      upsert(payload: unknown, opts?: unknown) { state.op = 'upsert'; state.payload = payload; state.filters.push({ method: 'upsertOpts', args: [opts] }); return builder; },
      delete(opts?: { count?: string }) { state.op = 'delete'; if (opts?.count) state.count = true; return builder; },
      eq: chain('eq'), or: chain('or'), in: chain('in'), is: chain('is'), lt: chain('lt'),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }

  const client = { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
  return { client, calls };
}

const filterArg = (state: QueryState, method: string) => state.filters.find((f) => f.method === method)?.args;

const PAYLOAD = bundleProspectPayloadV1Schema.parse({
  name: 'Jane Analyst',
  linkedin_url: 'https://www.linkedin.com/in/jane-analyst',
  experiences: [
    { title: 'Analyst', company: { name: 'Goldman Sachs' }, is_current: true },
  ],
});

// ── stableStringify / hashing ──────────────────────────────────────────

describe('stableStringify + hashPayload', () => {
  it('is insensitive to key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('identical payloads hash identically; different payloads differ', () => {
    const other = bundleProspectPayloadV1Schema.parse({ ...PAYLOAD, name: 'Someone Else' });
    expect(hashPayload(PAYLOAD)).toBe(hashPayload({ ...PAYLOAD }));
    expect(hashPayload(PAYLOAD)).not.toBe(hashPayload(other));
  });
});

// ── beginPublish ───────────────────────────────────────────────────────

describe('beginPublish', () => {
  it('creates a missing bundle and claims staging v1', async () => {
    const { client, calls } = createMockService((state) => {
      if (state.table === 'data_bundles' && state.op === 'select') return { data: null };
      if (state.table === 'data_bundles' && state.op === 'insert')
        return { data: { id: 9, version: 0, staging_version: null, staging_claimed_at: null } };
      if (state.table === 'data_bundles' && state.op === 'update') return { count: 1 };
      return {};
    });
    const result = await beginPublish(client, { slug: 'ib-banks', name: 'IB Banks' });
    expect(result).toEqual({ bundleId: 9, stagingVersion: 1 });
    const claim = calls.find((c) => c.op === 'update');
    expect((claim?.payload as Record<string, unknown>).staging_version).toBe(1);
    expect(filterArg(claim!, 'or')?.[0]).toContain('staging_version.is.null');
  });

  it('rejects when another publish holds an unexpired lock', async () => {
    const { client } = createMockService((state) => {
      if (state.op === 'select')
        return { data: { id: 9, version: 3, staging_version: 4, staging_claimed_at: new Date().toISOString() } };
      if (state.op === 'update') return { count: 0 }; // conditional claim matched 0 rows
      return {};
    });
    await expect(beginPublish(client, { slug: 'ib-banks' })).rejects.toThrowError(/publish in progress/);
  });

  it('refuses to create a bundle without a name', async () => {
    const { client } = createMockService(() => ({ data: null }));
    await expect(beginPublish(client, { slug: 'new-bundle' })).rejects.toThrowError(/no name/);
  });
});

// ── publishProspectsChunk ──────────────────────────────────────────────

function prospectsResponder(existing: Array<{ id: number; linkedin_url: string; payload_hash: string; version_added?: number }>) {
  return (state: QueryState) => {
    if (state.table === 'data_bundles') return { data: { id: 9, version: 3, staging_version: 4 } };
    if (state.table === 'bundle_prospects' && state.op === 'select') return { data: existing };
    if (state.table === 'bundle_prospects' && state.op === 'update') {
      const id = filterArg(state, 'eq')?.[1] as number;
      const row = existing.find((r) => r.id === id);
      return { data: { version_added: row?.version_added ?? 1 } };
    }
    return {};
  };
}

describe('publishProspectsChunk', () => {
  it('inserts new prospects with all version fields at staging', async () => {
    const { client, calls } = createMockService(prospectsResponder([]));
    const result = await publishProspectsChunk(client, 'ib-banks', 4, [PAYLOAD]);
    expect(result).toMatchObject({ added: 1, updated: 0, unchanged: 0 });
    const insert = calls.find((c) => c.table === 'bundle_prospects' && c.op === 'insert');
    const row = (insert?.payload as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ version_added: 4, version_updated: 4, version_last_seen: 4, payload_schema_version: 1 });
    expect(row.linkedin_url).toBe('https://www.linkedin.com/in/jane-analyst');
  });

  it('bumps version_updated only when the payload hash changed', async () => {
    const { client, calls } = createMockService(
      prospectsResponder([{ id: 1, linkedin_url: PAYLOAD.linkedin_url, payload_hash: 'stale-hash', version_added: 1 }]),
    );
    const result = await publishProspectsChunk(client, 'ib-banks', 4, [PAYLOAD]);
    expect(result).toMatchObject({ added: 0, updated: 1 });
    const update = calls.find((c) => c.table === 'bundle_prospects' && c.op === 'update');
    expect((update?.payload as Record<string, unknown>).version_updated).toBe(4);
    expect((update?.payload as Record<string, unknown>).removed_in_version).toBeNull();
    // The old resolution snapshot is keyed to the previous hash — clearing it
    // makes `resolved IS NULL` an exact "needs resolution" predicate (CAR-81).
    expect((update?.payload as Record<string, unknown>).resolved).toBeNull();
  });

  it('touches only version_last_seen when unchanged (no subscriber delta, keeps resolved)', async () => {
    const { client, calls } = createMockService(
      prospectsResponder([{ id: 1, linkedin_url: PAYLOAD.linkedin_url, payload_hash: hashPayload(PAYLOAD), version_added: 1 }]),
    );
    const result = await publishProspectsChunk(client, 'ib-banks', 4, [PAYLOAD]);
    expect(result).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    const update = calls.find((c) => c.table === 'bundle_prospects' && c.op === 'update');
    expect(update?.payload).not.toHaveProperty('version_updated');
    expect((update?.payload as Record<string, unknown>).version_last_seen).toBe(4);
    // Unchanged payload keeps its valid snapshot — must NOT be invalidated.
    expect(update?.payload).not.toHaveProperty('resolved');
  });

  it('counts a re-added prospect (version_added = staging) as readded', async () => {
    const { client } = createMockService(
      prospectsResponder([{ id: 1, linkedin_url: PAYLOAD.linkedin_url, payload_hash: hashPayload(PAYLOAD), version_added: 4 }]),
    );
    const result = await publishProspectsChunk(client, 'ib-banks', 4, [PAYLOAD]);
    expect(result).toMatchObject({ readded: 1, unchanged: 0 });
  });

  it('rejects the whole chunk on an invalid payload', async () => {
    const { client, calls } = createMockService(prospectsResponder([]));
    await expect(
      publishProspectsChunk(client, 'ib-banks', 4, [PAYLOAD, { name: '', linkedin_url: 'nope' }]),
    ).rejects.toThrowError(BundlePublishError);
    expect(calls.find((c) => c.op === 'insert')).toBeUndefined();
  });

  it('rejects when the staging version does not hold the lock', async () => {
    const { client } = createMockService(() => ({ data: { id: 9, version: 3, staging_version: 7 } }));
    await expect(publishProspectsChunk(client, 'ib-banks', 4, [PAYLOAD])).rejects.toThrowError(/not staging v4/);
  });
});

// ── publishCompaniesChunk ──────────────────────────────────────────────

describe('publishCompaniesChunk', () => {
  it('stamps version_last_seen on the membership upsert (merge, not ignoreDuplicates)', async () => {
    const { client, calls } = createMockService((state) => {
      if (state.table === 'data_bundles') return { data: { id: 9, version: 3, staging_version: 4 } };
      return {};
    });
    const result = await publishCompaniesChunk(client, 'ib-banks', 4, [
      { name: 'Goldman Sachs', offices: [] },
    ]);
    expect(result).toMatchObject({ companies: 1, offices: 0 });
    const upsert = calls.find((c) => c.table === 'bundle_companies' && c.op === 'upsert');
    expect(upsert?.payload).toMatchObject({ bundle_id: 9, company_id: 500, version_last_seen: 4 });
    // Existing memberships must be re-stamped, or finalize prunes them as
    // unseen — ignoreDuplicates would skip the conflict update entirely.
    const opts = filterArg(upsert!, 'upsertOpts')?.[0] as Record<string, unknown>;
    expect(opts.onConflict).toBe('bundle_id,company_id');
    expect(opts.ignoreDuplicates).toBeUndefined();
  });
});

// ── finalizePublish ────────────────────────────────────────────────────

function finalizeResponder(opts: { removedIds: number[]; changedCount: number; liveCount: number; companyCount: number; companiesPruned?: number }) {
  return (state: QueryState) => {
    if (state.table === 'data_bundles' && state.op === 'select')
      return { data: { id: 9, version: 3, staging_version: 4 } };
    if (state.table === 'bundle_prospects' && state.op === 'update')
      // Count-based: the soft-remove sets the column its filter tests, so the
      // representation is always empty — only the count is trustworthy.
      return { count: opts.removedIds.length };
    if (state.table === 'bundle_prospects' && state.count) {
      const isChangedQuery = state.filters.some((f) => f.method === 'eq' && f.args[0] === 'version_updated');
      return { count: isChangedQuery ? opts.changedCount : opts.liveCount };
    }
    if (state.table === 'bundle_companies' && state.op === 'delete') return { count: opts.companiesPruned ?? 0 };
    if (state.table === 'bundle_companies' && state.count) return { count: opts.companyCount };
    return {};
  };
}

describe('finalizePublish', () => {
  it('commits the version bump when the run changed something', async () => {
    const { client, calls } = createMockService(
      finalizeResponder({ removedIds: [11], changedCount: 5, liveCount: 40, companyCount: 6 }),
    );
    const result = await finalizePublish(client, 'ib-banks', 4);
    expect(result).toMatchObject({ published: true, version: 4, prospectCount: 40, companyCount: 6, removed: 1 });
    const patch = calls.filter((c) => c.table === 'data_bundles' && c.op === 'update').pop();
    expect(patch?.payload).toMatchObject({ version: 4, status: 'published', staging_version: null });
  });

  it('skips the version bump on a zero-change run (no fan-out storm)', async () => {
    const { client, calls } = createMockService(
      finalizeResponder({ removedIds: [], changedCount: 0, liveCount: 40, companyCount: 6 }),
    );
    const result = await finalizePublish(client, 'ib-banks', 4);
    expect(result).toMatchObject({ published: false, version: 3 });
    const patch = calls.filter((c) => c.table === 'data_bundles' && c.op === 'update').pop();
    expect(patch?.payload).not.toHaveProperty('version');
    expect(patch?.payload).toMatchObject({ staging_version: null, status: 'published' });
  });

  it('soft-removes rows not seen this run at the staging version', async () => {
    const { client, calls } = createMockService(
      finalizeResponder({ removedIds: [11, 12], changedCount: 0, liveCount: 38, companyCount: 6 }),
    );
    await finalizePublish(client, 'ib-banks', 4);
    const removal = calls.find((c) => c.table === 'bundle_prospects' && c.op === 'update');
    expect((removal?.payload as Record<string, unknown>).removed_in_version).toBe(4);
    expect(filterArg(removal!, 'lt')).toEqual(['version_last_seen', 4]);
    expect(filterArg(removal!, 'is')).toEqual(['removed_in_version', null]);
  });

  it('hard-deletes company memberships not stamped this run (stale or pre-CAR-63 NULL)', async () => {
    const { client, calls } = createMockService(
      finalizeResponder({ removedIds: [], changedCount: 0, liveCount: 40, companyCount: 99, companiesPruned: 5 }),
    );
    const result = await finalizePublish(client, 'ib-banks', 4);
    expect(result.companiesPruned).toBe(5);
    // company_count reflects the post-prune membership count.
    expect(result.companyCount).toBe(99);
    const prune = calls.find((c) => c.table === 'bundle_companies' && c.op === 'delete');
    expect(filterArg(prune!, 'eq')).toEqual(['bundle_id', 9]);
    expect(filterArg(prune!, 'or')?.[0]).toBe('version_last_seen.is.null,version_last_seen.lt.4');
  });

  it('a company-only prune does not bump the version (no prospect fan-out)', async () => {
    const { client, calls } = createMockService(
      finalizeResponder({ removedIds: [], changedCount: 0, liveCount: 40, companyCount: 99, companiesPruned: 5 }),
    );
    const result = await finalizePublish(client, 'ib-banks', 4);
    expect(result).toMatchObject({ published: false, version: 3, companiesPruned: 5 });
    const patch = calls.filter((c) => c.table === 'data_bundles' && c.op === 'update').pop();
    expect(patch?.payload).not.toHaveProperty('version');
    expect(patch?.payload).toMatchObject({ company_count: 99 });
  });
});

// ── Admin token auth ───────────────────────────────────────────────────

describe('isAuthorizedAdminToken', () => {
  it('accepts the correct bearer token', () => {
    expect(isAuthorizedAdminToken('Bearer s3cret', 's3cret')).toBe(true);
  });

  it('rejects wrong, missing, and malformed tokens', () => {
    expect(isAuthorizedAdminToken('Bearer wrong', 's3cret')).toBe(false);
    expect(isAuthorizedAdminToken(null, 's3cret')).toBe(false);
    expect(isAuthorizedAdminToken('s3cret', 's3cret')).toBe(false); // no Bearer prefix
  });

  it('rejects everything when the secret env is unset', () => {
    expect(isAuthorizedAdminToken('Bearer anything', undefined)).toBe(false);
  });
});
