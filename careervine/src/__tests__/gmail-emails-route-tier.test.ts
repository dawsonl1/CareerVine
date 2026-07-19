import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: GET /api/gmail/emails?contactId= is intentionally UNGATED so the free
 * Outreach per-contact history keeps working. The live background re-sync is the
 * only premium part and must be skipped in-handler for users without mailbox:read.
 * (Audit fix: gating the whole route would silently empty every free user's Sent tab.)
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };
let caps = new Set<string>();
const syncSpy = vi.fn();
const backfillSpy = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

const results: Record<string, { data: unknown; error: unknown }> = {
  // Ownership gate (CAR-133 / R2.6): a truthy row = the contact belongs to the user.
  contacts: { data: { id: 5 }, error: null },
  contact_emails: { data: [{ email: "jane@corp.com" }], error: null },
  email_messages: { data: [{ id: 1, subject: "Hi" }], error: null },
};
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "maybeSingle"]) chain[m] = () => chain;
      (chain as unknown as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve(results[table]);
      return chain;
    },
  })),
}));

vi.mock("@/lib/gmail-send-core", () => ({
  getConnection: vi.fn(async () => ({
    gmail_address: "me@gmail.com",
    send_as_aliases: ["me@myalias.dev"],
    last_gmail_sync_at: null,
  })),
}));

// CAR-153/R3.4: the route must hand its fire-and-forget work to waitUntil so
// Vercel keeps the invocation alive after the response is sent.
const waitUntilSpy = vi.fn();
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => waitUntilSpy(p),
}));

vi.mock("@/lib/gmail", () => ({
  syncEmailsForContact: (...a: unknown[]) => {
    syncSpy(...a);
    return Promise.resolve();
  },
  backfillEmailsForContact: (...a: unknown[]) => {
    backfillSpy(...a);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/capabilities/resolve", () => ({
  resolveCapabilities: vi.fn(async () => caps),
}));

import { GET } from "@/app/api/gmail/emails/route";

function makeRequest() {
  const url = "http://localhost:3000/api/gmail/emails?contactId=5";
  return {
    method: "GET",
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    json: async () => ({}),
  } as never;
}

async function call() {
  const res = await GET(makeRequest(), { params: Promise.resolve({}) });
  return { status: res.status, data: await res.json() };
}

describe("GET /api/gmail/emails — tier-aware background sync (CAR-102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1" };
    results.contacts = { data: { id: 5 }, error: null };
  });

  it("premium (mailbox:read) -> serves history AND triggers the background live sync", async () => {
    caps = new Set(["mailbox:read"]);
    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data.emails).toHaveLength(1);
    expect(syncSpy).toHaveBeenCalled();
  });

  it("wraps BOTH background calls (backfill + live sync) in waitUntil (CAR-153/R3.4)", async () => {
    caps = new Set(["mailbox:read"]);
    await call();
    expect(backfillSpy).toHaveBeenCalled();
    expect(syncSpy).toHaveBeenCalled();
    // One waitUntil per background call, each handed a promise.
    expect(waitUntilSpy).toHaveBeenCalledTimes(2);
    for (const [arg] of waitUntilSpy.mock.calls) {
      expect(arg).toBeInstanceOf(Promise);
    }
  });

  it("passes the alias-aware own-address list to the background sync (CAR-153/R2.5)", async () => {
    caps = new Set(["mailbox:read"]);
    await call();
    const ownAddresses = syncSpy.mock.calls[0][3];
    expect(ownAddresses).toEqual(["me@gmail.com", "me@myalias.dev"]);
  });

  it("free (no mailbox:read) -> serves cached history but NO live sync", async () => {
    caps = new Set(["outreach:portal"]);
    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data.emails).toHaveLength(1); // DB history still served — the free Sent tab is not empty
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("foreign contactId (not owned by the user) -> 404 with no background sync/backfill (CAR-133 / R2.6)", async () => {
    // The service client bypasses RLS; reading contact_emails by a raw, foreign
    // contactId would leak that contact's addresses and fire background jobs
    // against them. The ownership gate must return 404 before any of that.
    caps = new Set(["mailbox:read"]);
    results.contacts = { data: null, error: null };

    const { status } = await call();
    expect(status).toBe(404);
    expect(syncSpy).not.toHaveBeenCalled();
    expect(backfillSpy).not.toHaveBeenCalled();
  });
});
