import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin contacts GET (CAR-74): the card used to silently cap at 100 rows with
 * no count. These tests pin the new contract — exact total, offset paging,
 * network_status filter, and name-OR-company search.
 */

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

let authedUser: Record<string, unknown> = {
  id: "admin-1",
  email: "admin@example.com",
  app_metadata: { role: "admin" },
};

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })),
    },
  })),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock("@/lib/admin", () => ({
  writeAudit: vi.fn(),
}));

vi.mock("@/lib/bundle-queue", () => ({
  processSubscriptionsUnderBudget: vi.fn(),
}));

import { GET } from "@/app/api/admin/users/[id]/contacts/route";

type Call = { method: string; args: unknown[] };

/** Chainable query stub: records every call; `range`/`limit` resolve it. */
function makeChain(result: { data: unknown; error: unknown; count?: number | null }) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "ilike", "or", "order"]) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    });
  }
  for (const method of ["range", "limit"]) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(result);
    });
  }
  return { chain, calls };
}

function makeRequest(qs = "") {
  return {
    method: "GET",
    nextUrl: new URL(`http://localhost:3000/api/admin/users/u-1/contacts${qs}`),
    headers: new Headers(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
  } as any;
}

async function call(qs = "", params: Record<string, string> = { id: "u-1" }) {
  const response = await GET(makeRequest(qs), { params: Promise.resolve(params) });
  return { status: response.status, data: await response.json() };
}

const CONTACT_ROW = {
  id: 7,
  name: "Ada Lovelace",
  linkedin_url: null,
  network_status: "prospect",
  created_at: "2026-07-01T00:00:00Z",
  contact_emails: [{ email: "ada@example.com", is_primary: true }],
  contact_companies: [
    {
      title: "Engineer",
      is_current: false,
      start_date: "2020-01-01",
      companies: { name: "Old Co" },
    },
    {
      title: "PM",
      is_current: true,
      start_date: "2024-01-01",
      companies: { name: "Qualtrics" },
    },
  ],
};

let contactsChain: ReturnType<typeof makeChain>;
let companiesChain: ReturnType<typeof makeChain>;

function findCalls(calls: Call[], method: string) {
  return calls.filter((c) => c.method === method);
}

beforeEach(() => {
  vi.clearAllMocks();
  authedUser = { id: "admin-1", email: "admin@example.com", app_metadata: { role: "admin" } };
  contactsChain = makeChain({ data: [CONTACT_ROW], error: null, count: 2002 });
  companiesChain = makeChain({ data: [], error: null });
  mockFrom.mockImplementation((table: string) =>
    table === "contact_companies" ? companiesChain.chain : contactsChain.chain,
  );
});

describe("GET /api/admin/users/[id]/contacts", () => {
  it("returns the exact total alongside the page and maps the current role", async () => {
    const { status, data } = await call();
    expect(status).toBe(200);
    expect(data.total).toBe(2002);
    expect(data.contacts).toEqual([
      expect.objectContaining({
        id: 7,
        name: "Ada Lovelace",
        email: "ada@example.com",
        networkStatus: "prospect",
        title: "PM",
        company: "Qualtrics",
      }),
    ]);
    // select must request an exact count so truncation is never silent
    const select = findCalls(contactsChain.calls, "select")[0];
    expect(select.args[1]).toEqual({ count: "exact" });
  });

  it("falls back to the most recent role when none is current", async () => {
    contactsChain = makeChain({
      data: [
        {
          ...CONTACT_ROW,
          contact_companies: CONTACT_ROW.contact_companies.map((cc) => ({
            ...cc,
            is_current: false,
          })),
        },
      ],
      error: null,
      count: 1,
    });
    mockFrom.mockImplementation(() => contactsChain.chain);
    const { data } = await call();
    expect(data.contacts[0]).toMatchObject({ title: "PM", company: "Qualtrics" });
  });

  it("applies the network_status filter", async () => {
    await call("?status=bench");
    const eqs = findCalls(contactsChain.calls, "eq");
    expect(eqs).toContainEqual({ method: "eq", args: ["network_status", "bench"] });
  });

  it("rejects an unknown status value", async () => {
    const { status } = await call("?status=archived");
    expect(status).toBe(400);
  });

  it("pages via offset with a 100-row window", async () => {
    await call("?offset=100");
    const range = findCalls(contactsChain.calls, "range")[0];
    expect(range.args).toEqual([100, 199]);
  });

  it("searches by name only when no company matches", async () => {
    await call("?q=ada");
    // company-match lookup ran, scoped to the target user
    expect(mockFrom).toHaveBeenCalledWith("contact_companies");
    const ccEqs = findCalls(companiesChain.calls, "eq");
    expect(ccEqs).toContainEqual({ method: "eq", args: ["contacts.user_id", "u-1"] });
    // no matches → plain name ilike, no OR
    const ilikes = findCalls(contactsChain.calls, "ilike");
    expect(ilikes).toContainEqual({ method: "ilike", args: ["name", "%ada%"] });
    expect(findCalls(contactsChain.calls, "or")).toHaveLength(0);
  });

  it("folds company-name matches into an OR with the name search", async () => {
    companiesChain = makeChain({
      data: [{ contact_id: 7 }, { contact_id: 9 }, { contact_id: 7 }],
      error: null,
    });
    mockFrom.mockImplementation((table: string) =>
      table === "contact_companies" ? companiesChain.chain : contactsChain.chain,
    );
    await call("?q=qualtrics");
    const or = findCalls(contactsChain.calls, "or")[0];
    // deduped ids, name OR membership
    expect(or.args[0]).toBe("name.ilike.%qualtrics%,id.in.(7,9)");
  });

  it("strips PostgREST metacharacters from q", async () => {
    await call(`?q=${encodeURIComponent("a,b(c)%d*e")}`);
    const ilikes = findCalls(contactsChain.calls, "ilike");
    // sanitized: separators become spaces, no ,()%* survive into the pattern
    expect(ilikes).toContainEqual({ method: "ilike", args: ["name", "%a b c  d e%"] });
  });

  it("rejects non-admin callers", async () => {
    authedUser = { id: "user-9", app_metadata: {} };
    const { status } = await call();
    expect(status).toBe(403);
  });
});
