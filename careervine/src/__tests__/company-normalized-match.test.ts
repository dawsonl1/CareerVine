/**
 * CAR-44: normalized company-name matching + identity-less duplicate probe.
 *
 * The split-company defect: hand-named, identity-less rows ("Rubrik") never
 * matched the scraper's canonical rows ("Rubrik, Inc."), so contacts landed
 * on a sibling row the target/bundle didn't point at. These tests pin
 * (a) the normalizeCompanyName key — which MUST stay in sync with the SQL
 * expression behind companies.name_normalized (20260710170000) — including
 * the false-positive pairs the production audit rejected, and (b) the
 * resolver's normalized match + possible_duplicate_of warn surface.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findOrCreateCompany, normalizeCompanyName } from "@/lib/company-helpers";

// ── Programmable chained-builder mock (same shape as bulk-import-batching) ──

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}

type Responder = (
  state: QueryState,
) =>
  | { data?: unknown; error?: { message: string } | null; count?: number | null }
  | undefined;

function createMockClient(respond: Responder) {
  const calls: QueryState[] = [];
  function makeBuilder(table: string) {
    const state: QueryState = { table, op: "select", filters: [] };
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
      select: chain("select"),
      insert(p: unknown) { state.op = "insert"; state.payload = p; return builder; },
      update(p: unknown, opts?: unknown) {
        state.op = "update";
        state.payload = p;
        state.filters.push({ method: "updateOpts", args: [opts] });
        return builder;
      },
      delete() { state.op = "delete"; return builder; },
      eq: chain("eq"), neq: chain("neq"), in: chain("in"), is: chain("is"),
      ilike: chain("ilike"), like: chain("like"),
      order: chain("order"), limit: chain("limit"),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }
  return { client: { from: (t: string) => makeBuilder(t) } as unknown as SupabaseClient, calls };
}

const filterOf = (state: QueryState, method: string) =>
  state.filters.find((f) => f.method === method);

// ── normalizeCompanyName ────────────────────────────────────────────────

describe("normalizeCompanyName", () => {
  it("unifies legal-suffix and punctuation variants (the real split pairs)", () => {
    const same: Array<[string, string]> = [
      ["Rubrik", "Rubrik, Inc."],
      ["Lucid Software", "Lucid Software Inc."],
      ["Bloomberg", "Bloomberg LP"],
      ["doTERRA International", "doTERRA International LLC"],
      ["Merit Medical Systems", "Merit Medical Systems, Inc."],
      ["Reddit", "Reddit, Inc."],
      ["Hewlett-Packard", "Hewlett Packard"],
      ["Overstock.com", "Overstock com"],
    ];
    for (const [a, b] of same) {
      expect(normalizeCompanyName(a), `${a} ~ ${b}`).toBe(normalizeCompanyName(b));
    }
  });

  it("stays conservative — audited false-positive pairs must NOT unify", () => {
    const different: Array<[string, string]> = [
      ["Zoom", "Zoom Video Communications"],
      ["Traeger", "Traeger Pellet Grills, LLC"],
      ["SalesRabbit", "Sales Rabbit, Inc."],
      ["FranklinCovey", "Franklin Covey"],
      ["Verifi (Visa)", "Visa"],
      ["Cloudflare", "Lightstream"],
      ["Sierra", "Sierra Nevada Corporation"],
      ["Amazon", "Amazon Web Services"],
    ];
    for (const [a, b] of different) {
      expect(normalizeCompanyName(a), `${a} !~ ${b}`).not.toBe(normalizeCompanyName(b));
    }
  });

  it("handles edge shapes", () => {
    expect(normalizeCompanyName("!!!")).toBe("");
    // A bare suffix token is a name, not a suffix (needs a preceding word).
    expect(normalizeCompanyName("Inc.")).toBe("inc");
    expect(normalizeCompanyName("  X (Twitter) ")).toBe("x twitter");
    expect(normalizeCompanyName("Sales Rabbit, Inc.")).toBe("sales rabbit");
  });
});

// ── findOrCreateCompany: normalized name matching ───────────────────────

const RUBRIK_CANONICAL = {
  id: 4679,
  name: "Rubrik, Inc.",
  linkedin_company_id: "4840301",
  linkedin_url: null,
  universal_name: "rubrik-inc",
  logo_url: null,
};

describe("findOrCreateCompany normalized matching (CAR-44)", () => {
  it("resolves a name-only input to the suffix-variant canonical row instead of inserting", async () => {
    const { client, calls } = createMockClient((state) => {
      const eqNorm = filterOf(state, "eq");
      if (
        state.table === "companies" &&
        state.op === "select" &&
        eqNorm?.args[0] === "name_normalized" &&
        eqNorm?.args[1] === "rubrik"
      ) {
        return { data: [RUBRIK_CANONICAL] };
      }
      return { data: [] };
    });

    const result = await findOrCreateCompany(client, { name: "Rubrik" });
    expect(result.id).toBe(4679);
    expect(result.possible_duplicate_of).toBeUndefined();
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("flags an identity-less insert whose parenthetical token matches an existing company", async () => {
    const visa = { id: 154, name: "Visa", linkedin_company_id: "2190", linkedin_url: null, universal_name: "visa", logo_url: null };
    const { client, calls } = createMockClient((state) => {
      if (state.table !== "companies") return { data: [] };
      const inFilter = filterOf(state, "in");
      if (state.op === "select" && inFilter?.args[0] === "name_normalized") {
        expect(inFilter.args[1]).toEqual(expect.arrayContaining(["verifi", "visa"]));
        return { data: [visa] };
      }
      if (state.op === "insert") {
        return { data: { id: 9001, name: "Verifi (Visa)", linkedin_company_id: null, linkedin_url: null, universal_name: null, logo_url: null } };
      }
      return { data: [] };
    });

    const result = await findOrCreateCompany(client, { name: "Verifi (Visa)" });
    expect(result.id).toBe(9001);
    expect(result.possible_duplicate_of).toEqual({ id: 154, name: "Visa" });
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(1);
  });

  it("flags an identity-less insert that is a word-prefix of an existing name", async () => {
    const zoomVideo = { id: 3314, name: "Zoom Video Communications", linkedin_company_id: "2532259", linkedin_url: null, universal_name: "zoom", logo_url: null };
    const { client } = createMockClient((state) => {
      if (state.table !== "companies") return { data: [] };
      const likeFilter = filterOf(state, "like");
      if (state.op === "select" && likeFilter?.args[0] === "name_normalized") {
        expect(likeFilter.args[1]).toBe("zoom %");
        return { data: [zoomVideo] };
      }
      if (state.op === "insert") {
        return { data: { id: 9002, name: "Zoom", linkedin_company_id: null, linkedin_url: null, universal_name: null, logo_url: null } };
      }
      return { data: [] };
    });

    const result = await findOrCreateCompany(client, { name: "Zoom" });
    expect(result.possible_duplicate_of).toEqual({ id: 3314, name: "Zoom Video Communications" });
  });

  it("never probes when the input carries LinkedIn identity", async () => {
    const { client, calls } = createMockClient((state) => {
      if (state.table === "companies" && state.op === "insert") {
        return { data: { id: 9003, name: "Newco", linkedin_company_id: "777", linkedin_url: null, universal_name: null, logo_url: null } };
      }
      return { data: [] };
    });

    const result = await findOrCreateCompany(client, { name: "Newco", linkedin_company_id: "777" });
    expect(result.possible_duplicate_of).toBeUndefined();
    const probes = calls.filter(
      (c) =>
        c.op === "select" &&
        c.filters.some((f) => (f.method === "in" || f.method === "like") && f.args[0] === "name_normalized"),
    );
    expect(probes).toHaveLength(0);
  });
});

// ── claimCompanyRow: count-based CAS + primary-key re-read ──────────────

/**
 * CAR-158: claiming a linkedin_company_id onto a name-matched row WRITES the
 * same column its race guard filters on, so success is read from the row count
 * and the fresh row comes from a separate primary-key re-read (rule 17). These
 * pin all four outcomes — the win, the degraded win, the lost race, and the
 * unique-violation — since a regression here silently attaches contacts to the
 * wrong company row rather than failing.
 */

const CLAIM_ID = "4840301";
/** Hand-named row the resolver finds by normalized name; no LinkedIn identity yet. */
const UNCLAIMED = {
  id: 4679,
  name: "Rubrik",
  linkedin_company_id: null,
  linkedin_url: null,
  universal_name: null,
  logo_url: null,
};
/** The same row after a won claim, as the primary-key re-read would see it. */
const CLAIMED = { ...UNCLAIMED, linkedin_company_id: CLAIM_ID };
/** A different row that already owns the id — what a lost race resolves to. */
const ID_OWNER = { ...UNCLAIMED, id: 5001, name: "Rubrik, Inc.", linkedin_company_id: CLAIM_ID };

type MockResponse = { data?: unknown; error?: { message: string }; count?: number };

/**
 * Drives findOrCreateCompany down the name-match → claim path. The stable-id
 * probe and claimCompanyRow's owner lookup are the same query shape
 * (select.eq("linkedin_company_id").maybeSingle()), so they are told apart by
 * order: the first is always the probe, which must miss for the claim to run.
 */
function claimResponder(opts: { claim: MockResponse; reread?: MockResponse; owner?: MockResponse }): Responder {
  let idSelects = 0;
  return (state) => {
    if (state.table !== "companies") return { data: [] };
    if (state.op === "update") return opts.claim;
    if (state.op === "select") {
      const eqs = state.filters.filter((f) => f.method === "eq");
      if (eqs.some((f) => f.args[0] === "name_normalized")) return { data: [UNCLAIMED] };
      if (eqs.some((f) => f.args[0] === "id")) return opts.reread ?? { data: null };
      if (eqs.some((f) => f.args[0] === "linkedin_company_id")) {
        idSelects += 1;
        return idSelects === 1 ? { data: null } : (opts.owner ?? { data: null });
      }
    }
    return { data: [] };
  };
}

const CLAIM_INPUT = { name: "Rubrik", linkedin_company_id: CLAIM_ID };

const idOwnerLookups = (calls: QueryState[]) =>
  calls.filter(
    (c) => c.op === "select" && c.filters.some((f) => f.method === "eq" && f.args[0] === "linkedin_company_id"),
  );

const pkRereads = (calls: QueryState[]) =>
  calls.filter((c) => c.op === "select" && c.filters.some((f) => f.method === "eq" && f.args[0] === "id"));

describe("claimCompanyRow (CAR-158)", () => {
  it("returns the freshly re-read row when the claim wins", async () => {
    const { client, calls } = createMockClient(claimResponder({ claim: { count: 1 }, reread: { data: CLAIMED } }));

    const result = await findOrCreateCompany(client, CLAIM_INPUT);
    expect(result).toMatchObject({ id: 4679, linkedin_company_id: CLAIM_ID });

    // Success is read from the count, and the race guard still filters on the
    // very column the patch writes — that pairing is the whole point.
    const update = calls.find((c) => c.op === "update");
    expect(update?.payload).toMatchObject({ linkedin_company_id: CLAIM_ID });
    expect(update?.filters.find((f) => f.method === "updateOpts")?.args[0]).toEqual({ count: "exact" });
    expect(update?.filters.find((f) => f.method === "is")?.args).toEqual(["linkedin_company_id", null]);

    // Re-read is by primary key only; a won claim never needs the owner lookup.
    expect(pkRereads(calls)).toHaveLength(1);
    expect(idOwnerLookups(calls)).toHaveLength(1); // the stable-id probe only
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("falls through to the owner lookup when the post-claim re-read fails", async () => {
    const { client, calls } = createMockClient(
      claimResponder({
        claim: { count: 1 },
        reread: { data: null, error: { message: "read timeout" } },
        owner: { data: CLAIMED },
      }),
    );

    // The claim still landed, so the id owner IS this row — the degraded path
    // returns the same company, not a different one.
    const result = await findOrCreateCompany(client, CLAIM_INPUT);
    expect(result).toMatchObject({ id: 4679, linkedin_company_id: CLAIM_ID });
    expect(pkRereads(calls)).toHaveLength(1);
    expect(idOwnerLookups(calls)).toHaveLength(2); // probe + owner lookup
  });

  it("resolves to the id owner when the claim loses the race (count 0)", async () => {
    const { client, calls } = createMockClient(claimResponder({ claim: { count: 0 }, owner: { data: ID_OWNER } }));

    const result = await findOrCreateCompany(client, CLAIM_INPUT);
    expect(result).toMatchObject({ id: 5001, linkedin_company_id: CLAIM_ID });
    // A lost claim must not re-read the row it failed to claim.
    expect(pkRereads(calls)).toHaveLength(0);
    expect(idOwnerLookups(calls)).toHaveLength(2);
  });

  it("resolves to the id owner when the claim update errors (unique violation)", async () => {
    const { client, calls } = createMockClient(
      claimResponder({
        claim: { error: { message: 'duplicate key value violates unique constraint "companies_linkedin_company_id_key"' } },
        owner: { data: ID_OWNER },
      }),
    );

    const result = await findOrCreateCompany(client, CLAIM_INPUT);
    expect(result).toMatchObject({ id: 5001, linkedin_company_id: CLAIM_ID });
    expect(pkRereads(calls)).toHaveLength(0);
    // The error must never be swallowed into a bogus insert.
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("keeps the name-matched row when both the claim and the owner lookup come up empty", async () => {
    const { client } = createMockClient(claimResponder({ claim: { count: 0 }, owner: { data: null } }));

    const result = await findOrCreateCompany(client, CLAIM_INPUT);
    expect(result).toMatchObject({ id: 4679, linkedin_company_id: null });
  });
});
