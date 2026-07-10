import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyBundleDelta,
  claimSubscriptionSync,
  computeContactFingerprint,
  type BundleCore,
  type SubscriptionCore,
} from '@/lib/bundle-sync';
import { importPeopleChunk } from '@/lib/bulk-import';

vi.mock('@/lib/bulk-import', () => ({
  importPeopleChunk: vi.fn(async () => ({ results: [], offices_established: 0 })),
}));
const importMock = vi.mocked(importPeopleChunk);

// ── Programmable chained-builder mock (records every query) ───────────

interface QueryState {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Responder = (state: QueryState) => { data?: unknown; error?: { message: string } | null; count?: number | null } | undefined;

function createMockClient(respond: Responder) {
  const calls: QueryState[] = [];
  function makeBuilder(table: string) {
    const state: QueryState = { table, op: 'select', filters: [] };
    calls.push(state);
    const resolve = () => {
      const r = respond(state) ?? {};
      return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
    };
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      state.filters.push({ method, args });
      return builder;
    };
    Object.assign(builder, {
      select: chain('select'),
      insert(payload: unknown) { state.op = 'insert'; state.payload = payload; return builder; },
      update(payload: unknown) { state.op = 'update'; state.payload = payload; return builder; },
      upsert(payload: unknown, opts?: unknown) { state.op = 'upsert'; state.payload = payload; state.filters.push({ method: 'upsertOpts', args: [opts] }); return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq: chain('eq'), neq: chain('neq'), or: chain('or'), in: chain('in'), is: chain('is'),
      gt: chain('gt'), lt: chain('lt'), lte: chain('lte'), order: chain('order'), limit: chain('limit'),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }
  const client = { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
  return { client, calls };
}

const filterArgs = (state: QueryState, method: string) => state.filters.filter((f) => f.method === method).map((f) => f.args);
const hasFilter = (state: QueryState, method: string, args: unknown[]) =>
  filterArgs(state, method).some((a) => JSON.stringify(a) === JSON.stringify(args));

const BUNDLE: BundleCore = { id: 9, slug: 'ib-banks', name: 'IB Banks', version: 4 };
const SUB: SubscriptionCore = { id: 77, user_id: 'user-1', bundle_id: 9, status: 'active', synced_version: 2 };

const PROSPECT_ROW = {
  id: 301,
  linkedin_url: 'https://www.linkedin.com/in/jane-analyst',
  payload: {
    name: 'Jane Analyst',
    linkedin_url: 'https://www.linkedin.com/in/jane-analyst',
    tags: ['GS'],
  },
  payload_schema_version: 1,
};

/** Responder covering the tables applyBundleDelta touches; tests override
 * pieces via the `data` map. */
function responder(data: {
  prospects?: unknown[];
  removedProspects?: unknown[];
  existingContacts?: unknown[];
  contactSnapshots?: unknown[];
  states?: unknown[];
  links?: unknown[];
  existingLinks?: unknown[];
  siblingLinks?: unknown[];
  interactions?: unknown[];
}): Responder {
  return (state) => {
    if (state.table === 'bundle_prospects' && state.op === 'select') {
      const isRemovalQuery = filterArgs(state, 'gt').some((a) => a[0] === 'removed_in_version');
      return { data: isRemovalQuery ? (data.removedProspects ?? []) : (data.prospects ?? []) };
    }
    if (state.table === 'contacts' && state.op === 'select') {
      const wantsSnapshot = filterArgs(state, 'select').some((a) => String(a[0]).includes('stage_override'));
      return { data: wantsSnapshot ? (data.contactSnapshots ?? []) : (data.existingContacts ?? []) };
    }
    if (state.table === 'bundle_contact_state' && state.op === 'select') return { data: data.states ?? [] };
    if (state.table === 'bundle_subscription_contacts' && state.op === 'select') {
      const isSibling = state.filters.some((f) => f.method === 'neq');
      if (isSibling) return { data: data.siblingLinks ?? [] };
      const wantsLinkRows = filterArgs(state, 'select').some((a) => String(a[0]).includes('created_by_bundle'));
      return { data: wantsLinkRows ? (data.links ?? []) : (data.existingLinks ?? []) };
    }
    if (state.table === 'interactions') return { data: data.interactions ?? [] };
    if (['contact_companies', 'contact_emails', 'contact_tags', 'meeting_contacts', 'follow_up_action_items'].includes(state.table)) {
      return { data: [] };
    }
    if (state.op === 'update' || state.op === 'upsert' || state.op === 'insert' || state.op === 'delete') {
      return { data: { id: 1 } };
    }
    return {};
  };
}

beforeEach(() => {
  importMock.mockClear();
  importMock.mockResolvedValue({ results: [], offices_established: 0 });
});

// ── Apply phase ────────────────────────────────────────────────────────

describe('applyBundleDelta — apply phase', () => {
  it('bounds the delta by synced_version < version_updated <= pinnedVersion', async () => {
    const { client, calls } = createMockClient(responder({ prospects: [] }));
    await applyBundleDelta(client, SUB, BUNDLE, {});
    const query = calls.find((c) => c.table === 'bundle_prospects');
    expect(hasFilter(query!, 'gt', ['version_updated', 2])).toBe(true);
    expect(hasFilter(query!, 'lte', ['version_updated', 4])).toBe(true);
    expect(filterArgs(query!, 'or')[0][0]).toContain('removed_in_version.gt.4');
  });

  it('respects an explicit pin over the live bundle version', async () => {
    const { client, calls } = createMockClient(responder({ prospects: [] }));
    await applyBundleDelta(client, SUB, { ...BUNDLE, version: 9 }, { pinnedVersion: 4 });
    const query = calls.find((c) => c.table === 'bundle_prospects');
    expect(hasFilter(query!, 'lte', ['version_updated', 4])).toBe(true);
    const commit = calls.find((c) => c.table === 'bundle_subscriptions' && c.op === 'update');
    expect((commit?.payload as Record<string, unknown>).synced_version).toBe(4);
  });

  it('imports parsed payloads with the bundle merge policy and no photos', async () => {
    const { client } = createMockClient(responder({ prospects: [PROSPECT_ROW] }));
    await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(importMock).toHaveBeenCalledOnce();
    const [, userId, inputs, opts] = importMock.mock.calls[0];
    expect(userId).toBe('user-1');
    expect((inputs as Array<{ mapped: { import_source: string } }>)[0].mapped.import_source).toBe('bundle:ib-banks');
    expect(opts).toMatchObject({ mergePolicy: 'bundle', skipPhotos: true });
  });

  it('records created contacts as created_by_bundle with the prospect linkage key', async () => {
    importMock.mockResolvedValue({
      results: [{ linkedin_url: PROSPECT_ROW.linkedin_url, name: 'Jane', status: 'created', contact_id: 42, warnings: [] }],
      offices_established: 0,
    });
    const { client, calls } = createMockClient(
      responder({ prospects: [PROSPECT_ROW], contactSnapshots: [snapshotRow(42)] }),
    );
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.applied).toBe(1);
    const link = calls.find((c) => c.table === 'bundle_subscription_contacts' && c.op === 'insert');
    expect((link?.payload as Record<string, unknown>[])[0]).toMatchObject({
      subscription_id: 77,
      contact_id: 42,
      bundle_prospect_id: 301,
      created_by_bundle: true,
      first_applied_version: 4,
    });
    const stateWrite = calls.filter((c) => c.table === 'bundle_contact_state' && c.op === 'upsert').pop();
    const row = (stateWrite?.payload as Record<string, unknown>[])[0];
    expect(row.apply_started_at).toBeNull();
    expect(row.applied_fingerprint).toBeTruthy();
  });

  it('records merged-into-existing contacts as created_by_bundle=false', async () => {
    importMock.mockResolvedValue({
      results: [{ linkedin_url: PROSPECT_ROW.linkedin_url, name: 'Jane', status: 'updated', contact_id: 42, warnings: [], applied_patch: {} }],
      offices_established: 0,
    });
    const { client, calls } = createMockClient(
      responder({ prospects: [PROSPECT_ROW], existingContacts: [{ id: 42 }], contactSnapshots: [snapshotRow(42)] }),
    );
    await applyBundleDelta(client, SUB, BUNDLE, {});
    const link = calls.find((c) => c.table === 'bundle_subscription_contacts' && c.op === 'insert');
    expect((link?.payload as Record<string, unknown>[])[0]).toMatchObject({ created_by_bundle: false });
  });

  it('promotes fingerprint drift to sticky user_touched — except after an interrupted apply', async () => {
    const snap = snapshotRow(42);
    const staleFp = computeContactFingerprint({ ...fingerprintOf(snap), notes: 'old state' });
    const clean = createMockClient(
      responder({
        prospects: [PROSPECT_ROW],
        existingContacts: [{ id: 42 }],
        contactSnapshots: [snap],
        states: [{ contact_id: 42, applied_fingerprint: staleFp, user_touched: false, apply_started_at: null }],
      }),
    );
    await applyBundleDelta(clean.client, SUB, BUNDLE, {});
    const preWrite = clean.calls.find((c) => c.table === 'bundle_contact_state' && c.op === 'upsert');
    expect((preWrite?.payload as Record<string, unknown>[])[0]).toMatchObject({ user_touched: true });

    const interrupted = createMockClient(
      responder({
        prospects: [PROSPECT_ROW],
        existingContacts: [{ id: 42 }],
        contactSnapshots: [snap],
        states: [{ contact_id: 42, applied_fingerprint: staleFp, user_touched: false, apply_started_at: '2026-07-09T00:00:00Z' }],
      }),
    );
    await applyBundleDelta(interrupted.client, SUB, BUNDLE, {});
    const recovery = interrupted.calls.find((c) => c.table === 'bundle_contact_state' && c.op === 'upsert');
    expect((recovery?.payload as Record<string, unknown>[])[0]).toMatchObject({ user_touched: false });
  });

  it('reports skipped rows for unknown payload schema versions without importing them', async () => {
    const { client } = createMockClient(
      responder({ prospects: [{ ...PROSPECT_ROW, payload_schema_version: 99 }] }),
    );
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.skipped[0]).toContain('unknown_payload_schema_version:99');
    expect(importMock.mock.calls[0]?.[2] ?? []).toHaveLength(0);
  });

  it('hands back an apply cursor when the chunk is full and does not commit', async () => {
    importMock.mockResolvedValue({
      results: [{ linkedin_url: PROSPECT_ROW.linkedin_url, name: 'Jane', status: 'created', contact_id: 42, warnings: [] }],
      offices_established: 0,
    });
    const { client, calls } = createMockClient(
      responder({ prospects: [PROSPECT_ROW], contactSnapshots: [snapshotRow(42)] }),
    );
    const result = await applyBundleDelta(client, SUB, BUNDLE, { chunkSize: 1 });
    expect(result.done).toBe(false);
    expect(result.nextCursor).toEqual({ phase: 'apply', afterId: 301 });
    // The only subscription write is the resume checkpoint (CAR-54) — no
    // synced_version commit until both phases complete.
    const subUpdates = calls.filter((c) => c.table === 'bundle_subscriptions' && c.op === 'update');
    expect(subUpdates).toHaveLength(1);
    expect(subUpdates[0].payload).toEqual({
      sync_cursor: { phase: 'apply', afterId: 301, pinnedVersion: BUNDLE.version },
    });
  });
});

// ── Removal phase & commit ─────────────────────────────────────────────

const removalData = (opts: { touched?: boolean; sibling?: boolean; createdByBundle?: boolean }) => ({
  prospects: [],
  removedProspects: [{ id: 301, linkedin_url: PROSPECT_ROW.linkedin_url }],
  links: [{ id: 1, contact_id: 42, created_by_bundle: opts.createdByBundle ?? true, bundle_prospect_id: 301 }],
  contactSnapshots: [snapshotRow(42)],
  states: [{
    contact_id: 42,
    applied_fingerprint: computeContactFingerprint(fingerprintOf(snapshotRow(42))),
    user_touched: false,
    apply_started_at: null,
  }],
  interactions: opts.touched ? [{ contact_id: 42 }] : [],
  siblingLinks: opts.sibling ? [{ contact_id: 42 }] : [],
});

describe('applyBundleDelta — removal phase', () => {
  it('deletes untouched bundle-created contacts, scoped by user_id', async () => {
    const { client, calls } = createMockClient(responder(removalData({})));
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.removedContacts).toBe(1);
    const del = calls.find((c) => c.table === 'contacts' && c.op === 'delete');
    expect(hasFilter(del!, 'eq', ['user_id', 'user-1'])).toBe(true);
    expect(hasFilter(del!, 'in', ['id', [42]])).toBe(true);
  });

  it('orphans touched contacts (drops linkage only)', async () => {
    const { client, calls } = createMockClient(responder(removalData({ touched: true })));
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.removedContacts).toBe(0);
    expect(result.orphanedLinks).toBe(1);
    expect(calls.find((c) => c.table === 'contacts' && c.op === 'delete')).toBeUndefined();
  });

  it('never deletes a contact another active subscription still links', async () => {
    const { client, calls } = createMockClient(responder(removalData({ sibling: true })));
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.removedContacts).toBe(0);
    expect(result.orphanedLinks).toBe(1);
    expect(calls.find((c) => c.table === 'contacts' && c.op === 'delete')).toBeUndefined();
  });

  it('never deletes merged-into-existing contacts', async () => {
    const { client, calls } = createMockClient(responder(removalData({ createdByBundle: false })));
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.removedContacts).toBe(0);
    expect(calls.find((c) => c.table === 'contacts' && c.op === 'delete')).toBeUndefined();
  });

  it('commits synced_version to the pin only when both phases finish', async () => {
    const { client, calls } = createMockClient(responder({ prospects: [], removedProspects: [] }));
    const result = await applyBundleDelta(client, SUB, BUNDLE, {});
    expect(result.done).toBe(true);
    const commit = calls.find((c) => c.table === 'bundle_subscriptions' && c.op === 'update');
    expect(commit?.payload).toMatchObject({ synced_version: 4 });
  });
});

// ── Claims ─────────────────────────────────────────────────────────────

describe('claimSubscriptionSync', () => {
  it('takes a fresh claim only when free or expired', async () => {
    const { client, calls } = createMockClient((state) =>
      state.op === 'update' ? { count: 1 } : {},
    );
    const token = await claimSubscriptionSync(client, 77);
    expect(token).toBeTruthy();
    const claim = calls.find((c) => c.op === 'update');
    expect(filterArgs(claim!, 'or')[0][0]).toContain('sync_claimed_until.is.null');
  });

  it('renews via CAS on the prior token', async () => {
    const { client, calls } = createMockClient((state) =>
      state.op === 'update' ? { count: 1 } : {},
    );
    const token = await claimSubscriptionSync(client, 77, 'prior-token');
    expect(token).toBeTruthy();
    const claim = calls.find((c) => c.op === 'update');
    expect(hasFilter(claim!, 'eq', ['sync_claimed_until', 'prior-token'])).toBe(true);
    expect(filterArgs(claim!, 'or')).toHaveLength(0);
  });

  it('returns null when the conditional update matches no rows (claim held or token lost)', async () => {
    // Count-based on purpose: PostgREST re-applies filters to RETURNING rows,
    // so a successful claim returns an empty representation — .select() would
    // report every successful claim as a failure.
    const { client } = createMockClient((state) => (state.op === 'update' ? { count: 0 } : {}));
    expect(await claimSubscriptionSync(client, 77)).toBeNull();
  });
});

// ── helpers ────────────────────────────────────────────────────────────

function snapshotRow(id: number) {
  return {
    id,
    linkedin_url: PROSPECT_ROW.linkedin_url,
    name: 'Jane Analyst',
    headline: null,
    notes: null,
    persona: null,
    network_status: 'prospect',
    stage_override: null,
  };
}

function fingerprintOf(row: ReturnType<typeof snapshotRow>) {
  return {
    name: row.name,
    headline: row.headline,
    notes: row.notes,
    persona: row.persona,
    network_status: row.network_status,
    stage_override: row.stage_override,
    manual_employment_keys: [] as string[],
    manual_emails: [] as string[],
    tags: [] as string[],
  };
}
