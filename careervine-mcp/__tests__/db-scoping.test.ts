import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The MCP data layer runs with the service-role key (RLS bypassed), so every
 * query MUST hand-scope to the operating user. These tests pin that invariant
 * for the resolution/mutation entry points: the queries carry .eq(user_id,…),
 * and a row that doesn't match (foreign user → filtered out → null) is rejected.
 */

interface Recorded {
  table: string;
  method: string;
  filters: Array<[string, unknown]>;
}

const recorded: Recorded[] = [];
let nextData: unknown = null;

function makeBuilder(table: string) {
  const filters: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};
  for (const m of ["select", "order", "limit", "range", "gt", "in", "is", "update", "delete", "insert"]) {
    b[m] = () => b;
  }
  b.eq = (col: string, val: unknown) => { filters.push([col, val]); return b; };
  b.ilike = (col: string, val: unknown) => { filters.push([`ilike:${col}`, val]); return b; };
  const resolve = (method: string) => {
    recorded.push({ table, method, filters });
    return { data: nextData, error: null };
  };
  b.maybeSingle = async () => resolve("maybeSingle");
  b.single = async () => resolve("single");
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolve("await")).then((r) => ({ ...r, data: nextData ?? [] })).then(onF, onR);
  return b;
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));
vi.mock("@/lib/company-queries", () => ({ setCompanyQueriesClient: () => {} }));

import { initDb, resolveContact, assertContactOwned, setNetworkStatus } from "../lib/db.ts";

const USER = "user-1";
const CONTACT = { id: 5, name: "Jane", network_status: "prospect", stage_override: null };

beforeEach(() => {
  recorded.length = 0;
  nextData = null;
  initDb(USER);
});

describe("db user-scoping", () => {
  it("resolveContact by id scopes to the operating user", async () => {
    nextData = CONTACT;
    const c = await resolveContact({ contact_id: 5 });
    expect(c.id).toBe(5);
    const q = recorded.find((r) => r.table === "contacts");
    expect(q?.filters).toContainEqual(["user_id", USER]);
    expect(q?.filters).toContainEqual(["id", 5]);
  });

  it("rejects a contact id that doesn't resolve under the user's scope", async () => {
    nextData = null; // scoped query returns nothing → not this user's contact
    await expect(resolveContact({ contact_id: 999 })).rejects.toThrow(/No contact with id 999/);
    await expect(assertContactOwned(999)).rejects.toThrow(/No contact with id 999/);
  });

  it("setNetworkStatus checks ownership and scopes the update by user_id", async () => {
    nextData = CONTACT;
    await setNetworkStatus(5, "active");
    // The ownership read + the update both target the contacts table, and every
    // contacts query in the flow is user-scoped.
    const contactsQueries = recorded.filter((r) => r.table === "contacts");
    expect(contactsQueries.length).toBeGreaterThanOrEqual(2);
    for (const q of contactsQueries) {
      expect(q.filters).toContainEqual(["user_id", USER]);
    }
  });
});
