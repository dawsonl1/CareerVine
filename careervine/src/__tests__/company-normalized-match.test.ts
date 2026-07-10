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
) => { data?: unknown; error?: { message: string } | null } | undefined;

function createMockClient(respond: Responder) {
  const calls: QueryState[] = [];
  function makeBuilder(table: string) {
    const state: QueryState = { table, op: "select", filters: [] };
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
      select: chain("select"),
      insert(p: unknown) { state.op = "insert"; state.payload = p; return builder; },
      update(p: unknown) { state.op = "update"; state.payload = p; return builder; },
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
