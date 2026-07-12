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
  contact_emails: { data: [{ email: "jane@corp.com" }], error: null },
  email_messages: { data: [{ id: 1, subject: "Hi" }], error: null },
};
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) chain[m] = () => chain;
      (chain as unknown as { then: unknown }).then = (resolve: (v: unknown) => void) =>
        resolve(results[table]);
      return chain;
    },
  })),
}));

vi.mock("@/lib/gmail", () => ({
  getConnection: vi.fn(async () => ({ gmail_address: "me@gmail.com", last_gmail_sync_at: null })),
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
  });

  it("premium (mailbox:read) -> serves history AND triggers the background live sync", async () => {
    caps = new Set(["mailbox:read"]);
    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data.emails).toHaveLength(1);
    expect(syncSpy).toHaveBeenCalled();
  });

  it("free (no mailbox:read) -> serves cached history but NO live sync", async () => {
    caps = new Set(["outreach:portal"]);
    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data.emails).toHaveLength(1); // DB history still served — the free Sent tab is not empty
    expect(syncSpy).not.toHaveBeenCalled();
  });
});
