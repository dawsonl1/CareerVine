import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * add_contact (createContactFull) must canonicalize a US state to its full name
 * before find-or-creating the location, so an agent passing "CA" lands on the
 * same `locations` row as "California" — the canonical form the web dropdown
 * (CAR-114) and the scrape/import pipeline store. findOrCreateLocation matches
 * on exact state equality, so a mismatch silently duplicates the location.
 *
 * Harness mirrors db-scoping.test.ts: the service-client builder records every
 * `.eq()` filter, so we can assert the state the `locations` lookup was given.
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
vi.mock("@/lib/analytics/server", () => ({
  trackServer: async () => {},
  checkContactMilestone: async () => {},
}));

import { initDb, createContactFull } from "../lib/db";

const USER = "user-1";

/** state passed to the `locations` lookup for the given add_contact location. */
async function stateWrittenFor(location: { city?: string; state?: string; country: string }): Promise<unknown> {
  recorded.length = 0; // isolate this call (a test may make several)
  nextData = { id: 1 }; // location lookup + contact insert both resolve to this
  await createContactFull({ name: "Test", location });
  const loc = recorded.find((r) => r.table === "locations");
  const stateFilter = loc?.filters.find(([col]) => col === "state");
  return stateFilter?.[1];
}

beforeEach(() => {
  recorded.length = 0;
  nextData = null;
  initDb(USER);
});

describe("add_contact location state normalization", () => {
  it("canonicalizes a US 2-letter state to the full name", async () => {
    expect(await stateWrittenFor({ city: "San Francisco", state: "CA", country: "United States" }))
      .toBe("California");
  });

  it("canonicalizes lowercase / full-name US states to the canonical full name", async () => {
    expect(await stateWrittenFor({ city: "Austin", state: "texas", country: "United States" }))
      .toBe("Texas");
    expect(await stateWrittenFor({ city: "New York", state: "New York", country: "United States" }))
      .toBe("New York");
  });

  it("treats US aliases (USA) as the United States", async () => {
    expect(await stateWrittenFor({ city: "Seattle", state: "wa", country: "USA" }))
      .toBe("Washington");
  });

  it("falls back to the raw value for an unrecognized US state", async () => {
    expect(await stateWrittenFor({ city: "Metropolis", state: "Freedonia", country: "United States" }))
      .toBe("Freedonia");
  });

  it("leaves a non-US state untouched", async () => {
    expect(await stateWrittenFor({ city: "Toronto", state: "ON", country: "Canada" }))
      .toBe("ON");
  });
});
