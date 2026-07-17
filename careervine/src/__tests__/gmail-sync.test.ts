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
 *
 * The mock Supabase client simulates the PostgREST behavior that matters:
 * filters, ordering, and the 1000-row response cap.
 */

// ── Gmail API mock ─────────────────────────────────────────────────────

const listCalls: string[] = [];
const failAddresses = new Set<string>();

vi.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        messages: {
          list: async (args: { q: string }) => {
            listCalls.push(args.q);
            for (const addr of failAddresses) {
              if (args.q.includes(addr)) throw new Error(`simulated Gmail failure for ${addr}`);
            }
            return { data: { messages: [] } };
          },
          get: async () => ({ data: {} }),
        },
      },
    }),
    auth: { OAuth2: class {} },
  },
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

describe('syncAllContactEmails', () => {
  beforeEach(() => {
    listCalls.length = 0;
    updateOps.length = 0;
    failAddresses.clear();
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
});
