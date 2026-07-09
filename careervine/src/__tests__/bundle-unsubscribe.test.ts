import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  unsubscribeFromBundle,
  computeContactFingerprint,
  type SubscriptionCore,
} from '@/lib/bundle-sync';

// ── Minimal programmable mock (same shape as bundle-sync.test.ts) ──────

interface QueryState {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Responder = (state: QueryState) => { data?: unknown; error?: { message: string } | null } | undefined;

function createMockClient(respond: Responder) {
  const calls: QueryState[] = [];
  function makeBuilder(table: string) {
    const state: QueryState = { table, op: 'select', filters: [] };
    calls.push(state);
    const resolve = () => {
      const r = respond(state) ?? {};
      return { data: r.data ?? null, error: r.error ?? null };
    };
    const builder: Record<string, unknown> = {};
    const chain = (method: string) => (...args: unknown[]) => {
      state.filters.push({ method, args });
      return builder;
    };
    Object.assign(builder, {
      select: chain('select'),
      insert(p: unknown) { state.op = 'insert'; state.payload = p; return builder; },
      update(p: unknown) { state.op = 'update'; state.payload = p; return builder; },
      upsert(p: unknown) { state.op = 'upsert'; state.payload = p; return builder; },
      delete() { state.op = 'delete'; return builder; },
      eq: chain('eq'), neq: chain('neq'), or: chain('or'), in: chain('in'), is: chain('is'),
      gt: chain('gt'), lt: chain('lt'), lte: chain('lte'), order: chain('order'), limit: chain('limit'),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }
  return { client: { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient, calls };
}

const filterArgs = (s: QueryState, m: string) => s.filters.filter((f) => f.method === m).map((f) => f.args);
const hasFilter = (s: QueryState, m: string, args: unknown[]) =>
  filterArgs(s, m).some((a) => JSON.stringify(a) === JSON.stringify(args));

const SUB: SubscriptionCore = { id: 77, user_id: 'user-1', bundle_id: 9, status: 'active', synced_version: 4 };

const SNAPSHOT = {
  id: 42, linkedin_url: 'https://www.linkedin.com/in/jane', name: 'Jane', headline: null,
  notes: null, persona: null, network_status: 'prospect', stage_override: null,
};
const CLEAN_FP = computeContactFingerprint({
  name: 'Jane', headline: null, notes: null, persona: null, network_status: 'prospect',
  stage_override: null, manual_employment_keys: [], manual_emails: [], tags: [],
});

function responder(opts: {
  links?: unknown[];
  touched?: boolean;
  sibling?: boolean;
  keepAllDropped?: unknown[];
}): Responder {
  return (state) => {
    if (state.table === 'bundle_subscription_contacts' && state.op === 'select') {
      return state.filters.some((f) => f.method === 'neq')
        ? { data: opts.sibling ? [{ contact_id: 42 }] : [] }
        : { data: opts.links ?? [] };
    }
    if (state.table === 'bundle_subscription_contacts' && state.op === 'delete') {
      return { data: opts.keepAllDropped ?? [{ id: 1 }] };
    }
    if (state.table === 'contacts' && state.op === 'select') return { data: [SNAPSHOT] };
    if (state.table === 'bundle_contact_state') {
      return { data: [{ contact_id: 42, applied_fingerprint: CLEAN_FP, user_touched: false, apply_started_at: null }] };
    }
    if (state.table === 'interactions') return { data: opts.touched ? [{ contact_id: 42 }] : [] };
    if (['contact_companies', 'contact_emails', 'contact_tags', 'meeting_contacts', 'follow_up_action_items'].includes(state.table)) {
      return { data: [] };
    }
    return { data: { id: 1 } };
  };
}

const LINK = { id: 5, contact_id: 42, created_by_bundle: true };

describe('unsubscribeFromBundle', () => {
  it('flips status to unsubscribed and clears the sync claim on the first call', async () => {
    const { client, calls } = createMockClient(responder({ links: [] }));
    await unsubscribeFromBundle(client, SUB, { keepAll: false });
    const statusFlip = calls.find((c) => c.table === 'bundle_subscriptions' && c.op === 'update');
    expect(statusFlip?.payload).toMatchObject({ status: 'unsubscribed', sync_claimed_until: null });
  });

  it('does not re-flip status on continuation calls', async () => {
    const { client, calls } = createMockClient(responder({ links: [] }));
    await unsubscribeFromBundle(client, SUB, { keepAll: false, cursor: 5 });
    expect(calls.find((c) => c.table === 'bundle_subscriptions' && c.op === 'update')).toBeUndefined();
  });

  it('keepAll drops all linkage and deletes nothing', async () => {
    const { client, calls } = createMockClient(responder({ keepAllDropped: [{ id: 1 }, { id: 2 }] }));
    const result = await unsubscribeFromBundle(client, SUB, { keepAll: true });
    expect(result).toMatchObject({ done: true, kept: 2, removed: 0 });
    expect(calls.find((c) => c.table === 'contacts' && c.op === 'delete')).toBeUndefined();
  });

  it('removes untouched bundle-created contacts, scoped by user', async () => {
    const { client, calls } = createMockClient(responder({ links: [LINK] }));
    const result = await unsubscribeFromBundle(client, SUB, { keepAll: false });
    expect(result).toMatchObject({ done: true, removed: 1, kept: 0 });
    const del = calls.find((c) => c.table === 'contacts' && c.op === 'delete');
    expect(hasFilter(del!, 'eq', ['user_id', 'user-1'])).toBe(true);
  });

  it('keeps touched contacts (hard signal) and merged-into-existing contacts', async () => {
    const touched = createMockClient(responder({ links: [LINK], touched: true }));
    expect(await unsubscribeFromBundle(touched.client, SUB, { keepAll: false })).toMatchObject({ removed: 0, kept: 1 });

    const merged = createMockClient(responder({ links: [{ ...LINK, created_by_bundle: false }] }));
    expect(await unsubscribeFromBundle(merged.client, SUB, { keepAll: false })).toMatchObject({ removed: 0, kept: 1 });
  });

  it('keeps contacts still linked by a sibling active subscription', async () => {
    const { client, calls } = createMockClient(responder({ links: [LINK], sibling: true }));
    const result = await unsubscribeFromBundle(client, SUB, { keepAll: false });
    expect(result).toMatchObject({ removed: 0, kept: 1 });
    expect(calls.find((c) => c.table === 'contacts' && c.op === 'delete')).toBeUndefined();
  });

  it('never writes suppressed_imports tombstones', async () => {
    const { client, calls } = createMockClient(responder({ links: [LINK] }));
    await unsubscribeFromBundle(client, SUB, { keepAll: false });
    expect(calls.find((c) => c.table === 'suppressed_imports')).toBeUndefined();
  });

  it('hands back a cursor when the linkage chunk is full', async () => {
    const links = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, contact_id: 42, created_by_bundle: false }));
    const { client } = createMockClient(responder({ links }));
    const result = await unsubscribeFromBundle(client, SUB, { keepAll: false, chunkSize: 3 });
    expect(result.done).toBe(false);
    expect(result.nextCursor).toBe(3);
  });
});
