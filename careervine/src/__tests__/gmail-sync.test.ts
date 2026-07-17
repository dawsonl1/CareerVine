import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the Gmail sync path (the "emails aren't syncing" fixes).
 *
 * Structural defects pinned here:
 *   1. /api/gmail/sync must declare maxDuration — the platform default
 *      kills a non-trivial sync mid-run.
 *   2. syncAllContactEmails must paginate the contact fetch — PostgREST
 *      caps a single response at 1000 rows, silently dropping the tail.
 *   3. The loop must stop at its time budget and hand back a cursor,
 *      and must NOT stamp last_gmail_sync_at on a partial pass.
 *   4. Per-contact failures are counted and reported, not swallowed.
 *   5. CAR-153/R3.4: the per-contact pool is capped at 4 concurrent syncs,
 *      and the resume cursor stays CONTIGUOUS under out-of-order completion
 *      so a yield can never skip a contact.
 *
 * The mock Supabase client simulates the PostgREST behavior that matters:
 * filters, ordering, and the 1000-row response cap.
 */

// ── Gmail API mock ─────────────────────────────────────────────────────

const listCalls: string[] = [];
const failAddresses = new Set<string>();
// Awaitable gates keyed by an address substring: a matching list call holds
// until the gate resolves — how the pool tests control completion order.
const listGates = new Map<string, Promise<void>>();
let inFlightListCalls = 0;
let maxInFlightListCalls = 0;
let sendAsRows: { sendAsEmail?: string }[] = [];

vi.mock('@googleapis/gmail', () => ({
  gmail: () => ({
    users: {
      messages: {
        list: async (args: { q: string }) => {
          listCalls.push(args.q);
          inFlightListCalls++;
          maxInFlightListCalls = Math.max(maxInFlightListCalls, inFlightListCalls);
          try {
            for (const [addr, gate] of listGates) {
              if (args.q.includes(addr)) await gate;
            }
            for (const addr of failAddresses) {
              if (args.q.includes(addr)) throw new Error(`simulated Gmail failure for ${addr}`);
            }
            return { data: { messages: [] } };
          } finally {
            inFlightListCalls--;
          }
        },
        get: async () => ({ data: {} }),
      },
      settings: {
        sendAs: {
          list: async () => ({ data: { sendAs: sendAsRows } }),
        },
      },
    },
  }),
}));

vi.mock('@/lib/oauth-helpers', () => ({
  getOAuth2Client: () => ({ setCredentials: () => {} }),
  refreshTokenIfNeeded: async () => {},
  decryptOAuthToken: (v: string) => v,
  encryptOAuthToken: (v: string) => v,
}));

// ── Supabase service-client mock ───────────────────────────────────────

const POSTGREST_MAX_ROWS = 1000;

interface MockTables {
  gmail_connections: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  email_messages: Record<string, unknown>[];
}

const tables: MockTables = { gmail_connections: [], contacts: [], email_messages: [] };
const updateOps: { table: string; values: Record<string, unknown> }[] = [];

function makeBuilder(tableName: keyof MockTables) {
  const gtFilters: [string, number][] = [];
  let orderCol: string | null = null;
  let orderAsc = true;
  let rangeArgs: [number, number] | null = null;

  const resolveRows = () => {
    let rows = [...tables[tableName]];
    for (const [col, val] of gtFilters) {
      rows = rows.filter((r) => (r[col] as number) > val);
    }
    if (orderCol) {
      rows.sort((a, b) => ((a[orderCol!] as number) - (b[orderCol!] as number)) * (orderAsc ? 1 : -1));
    }
    // Simulate PostgREST: .range() slices; either way, ≤1000 rows per response.
    if (rangeArgs) rows = rows.slice(rangeArgs[0], rangeArgs[1] + 1);
    return rows.slice(0, POSTGREST_MAX_ROWS);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    gt: (col: string, val: number) => {
      gtFilters.push([col, val]);
      return builder;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orderCol = col;
      orderAsc = opts?.ascending ?? true;
      return builder;
    },
    range: (from: number, to: number) => {
      rangeArgs = [from, to];
      return builder;
    },
    limit: () => builder,
    in: () => builder,
    is: () => builder,
    contains: () => builder,
    update: (values: Record<string, unknown>) => {
      updateOps.push({ table: tableName, values });
      return builder;
    },
    single: async () => {
      const row = resolveRows()[0] ?? null;
      return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116' } };
    },
    maybeSingle: async () => ({ data: resolveRows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => {
      resolve({ data: resolveRows(), error: null, count: null });
    },
  };
  return builder;
}

vi.mock('@/lib/supabase/service-client', () => ({
  createSupabaseServiceClient: () => ({
    from: (table: keyof MockTables) => makeBuilder(table),
  }),
}));

// ── Tests ──────────────────────────────────────────────────────────────

function seedContacts(n: number) {
  tables.contacts = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    contact_emails: [{ email: `person${i + 1}@example.com` }],
  }));
}

describe('/api/gmail/sync route config', () => {
  it('declares maxDuration so the sync is not killed at the platform default', async () => {
    const route = await import('@/app/api/gmail/sync/route');
    expect((route as { maxDuration?: number }).maxDuration).toBe(60);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 10));

describe('syncAllContactEmails', () => {
  beforeEach(() => {
    vi.useRealTimers();
    listCalls.length = 0;
    updateOps.length = 0;
    failAddresses.clear();
    listGates.clear();
    inFlightListCalls = 0;
    maxInFlightListCalls = 0;
    sendAsRows = [];
    tables.gmail_connections = [
      {
        id: 1,
        user_id: 'user-1',
        gmail_address: 'me@example.com',
        access_token: 'at',
        refresh_token: 'rt',
        token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        last_gmail_sync_at: null,
        created_at: new Date().toISOString(),
      },
    ];
    tables.email_messages = [];
  });

  it('syncs every contact with an email, even past the 1000-row PostgREST cap', async () => {
    seedContacts(1200);

    const { syncAllContactEmails } = await import('@/lib/gmail');
    const result = await syncAllContactEmails('user-1');

    expect(listCalls.length).toBe(1200);
    expect(result.processedContacts).toBe(1200);
    expect(result.nextCursor).toBeNull();
  });

  it('stops at the time budget with a resumable cursor, always making progress', async () => {
    seedContacts(5);

    const { syncAllContactEmails } = await import('@/lib/gmail');
    // Zero budget: must still process exactly one contact, then yield.
    const first = await syncAllContactEmails('user-1', 90, { budgetMs: 0 });
    expect(first.processedContacts).toBe(1);
    expect(first.nextCursor).toBe(1);

    // Resuming from the cursor picks up the next contact, not the first.
    listCalls.length = 0;
    const second = await syncAllContactEmails('user-1', 90, { cursor: first.nextCursor!, budgetMs: 0 });
    expect(second.processedContacts).toBe(1);
    expect(second.nextCursor).toBe(2);
    expect(listCalls[0]).toContain('person2@example.com');
  });

  it('counts per-contact failures instead of swallowing them silently', async () => {
    seedContacts(4);
    failAddresses.add('person3@example.com');

    const { syncAllContactEmails } = await import('@/lib/gmail');
    const result = await syncAllContactEmails('user-1');

    expect(result.failedContacts).toBe(1);
    expect(result.processedContacts).toBe(4); // failure doesn't stop the loop
    expect(result.nextCursor).toBeNull();
  });

  it('stamps last_gmail_sync_at only when a pass completes', async () => {
    seedContacts(3);

    const { syncAllContactEmails } = await import('@/lib/gmail');

    // Partial pass (budget exhausted): no timestamp update.
    await syncAllContactEmails('user-1', 90, { budgetMs: 0 });
    expect(updateOps.filter((op) => op.table === 'gmail_connections')).toHaveLength(0);

    // Completed pass: timestamp updated.
    await syncAllContactEmails('user-1');
    const stamps = updateOps.filter((op) => op.table === 'gmail_connections');
    expect(stamps).toHaveLength(1);
    expect(stamps[0].values).toHaveProperty('last_gmail_sync_at');
  });

  // ── CAR-153/R3.4: bounded pool + contiguous cursor ────────────────────

  it('caps concurrent per-contact syncs at the pool size (4)', async () => {
    seedContacts(10);
    const gate = deferred();
    for (let i = 1; i <= 10; i++) listGates.set(`person${i}@example.com`, gate.promise);

    const { syncAllContactEmails } = await import('@/lib/gmail');
    const resultPromise = syncAllContactEmails('user-1');
    await flush();

    // All 10 gated: exactly the pool size may be in flight, never more.
    expect(inFlightListCalls).toBe(4);

    gate.resolve();
    const result = await resultPromise;

    expect(result.processedContacts).toBe(10);
    expect(result.nextCursor).toBeNull();
    expect(maxInFlightListCalls).toBe(4);
  });

  it('keeps the resume cursor contiguous under out-of-order completion', async () => {
    // Only Date is faked (budget math); timers stay real so the pool's
    // awaits and the test's flushes run normally.
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = new Date('2026-07-17T10:00:00Z').getTime();
    vi.setSystemTime(T0);

    seedContacts(6);
    const gates = Array.from({ length: 6 }, () => deferred());
    for (let i = 1; i <= 6; i++) listGates.set(`person${i}@example.com`, gates[i - 1].promise);

    const { syncAllContactEmails } = await import('@/lib/gmail');
    const resultPromise = syncAllContactEmails('user-1', 90, { budgetMs: 10_000 });
    await flush();

    // Pool filled: contacts 1-4 in flight.
    expect(inFlightListCalls).toBe(4);

    // Contact 2 completes FIRST (out of order) and the budget expires before
    // the pool considers launching contact 5.
    vi.setSystemTime(T0 + 11_000);
    gates[1].resolve();
    await flush();

    // Budget gate stops launching; the drain still awaits contacts 1, 3, 4.
    gates[0].resolve();
    gates[2].resolve();
    gates[3].resolve();
    const result = await resultPromise;

    // The cursor is the highest CONTIGUOUS settled contact — 4, with every
    // contact ≤ 4 attempted exactly once and 5/6 untouched for the resume.
    expect(result.nextCursor).toBe(4);
    expect(result.processedContacts).toBe(4);
    for (let i = 1; i <= 4; i++) {
      expect(listCalls.filter((q) => q.includes(`person${i}@example.com`))).toHaveLength(1);
    }
    expect(listCalls.some((q) => q.includes('person5@example.com'))).toBe(false);
    expect(listCalls.some((q) => q.includes('person6@example.com'))).toBe(false);
    // Partial pass: last_gmail_sync_at untouched.
    expect(updateOps.filter((op) => op.table === 'gmail_connections')).toHaveLength(0);
  });

  it('opportunistically refreshes the send-as alias set when modify scope is granted', async () => {
    seedContacts(1);
    tables.gmail_connections[0].modify_scope_granted = true;
    sendAsRows = [{ sendAsEmail: 'Me@Gmail.com' }, { sendAsEmail: ' Alias@X.dev ' }];

    const { syncAllContactEmails } = await import('@/lib/gmail');
    await syncAllContactEmails('user-1');

    const aliasWrites = updateOps.filter(
      (op) => op.table === 'gmail_connections' && 'send_as_aliases' in op.values
    );
    expect(aliasWrites).toHaveLength(1);
    expect(aliasWrites[0].values.send_as_aliases).toEqual(['me@gmail.com', 'alias@x.dev']);
  });
});
