import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readProspectResolution,
  resolveBundleChunk,
  markBundleResolved,
  type BundleProspectResolution,
} from "@/lib/bundle-resolve";
import { hashPayload } from "@/lib/bundle-publish";

// ── Mock client (chained builder + rpc) ────────────────────────────────

interface QueryState {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
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
      upsert(p: unknown, opts?: unknown) { state.op = "upsert"; state.payload = p; state.filters.push({ method: "upsertOpts", args: [opts] }); return builder; },
      delete() { state.op = "delete"; return builder; },
      eq: chain("eq"), neq: chain("neq"), or: chain("or"), in: chain("in"), is: chain("is"),
      gt: chain("gt"), lt: chain("lt"), lte: chain("lte"), ilike: chain("ilike"),
      order: chain("order"), limit: chain("limit"),
      async single() { return resolve(); },
      async maybeSingle() { return resolve(); },
      then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
    });
    return builder;
  }
  const client = {
    from: (table: string) => makeBuilder(table),
    rpc(fn: string, args: unknown) {
      const state: QueryState = { table: `rpc:${fn}`, op: "rpc", payload: args, filters: [] };
      calls.push(state);
      const r = respond(state) ?? {};
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const byTable = (calls: QueryState[], table: string, op?: QueryState["op"]) =>
  calls.filter((c) => c.table === table && (!op || c.op === op));

// ── Fixtures ───────────────────────────────────────────────────────────

const BUNDLE = { id: 1, slug: "apm-data-bundle", version: 3 };

const ACME = { id: 10, name: "Acme", linkedin_company_id: "555", linkedin_url: null, universal_name: null, logo_url: null };
const PROVO = { id: 20, city: "Provo", state: "Utah", country: "United States" };

const JANE_PAYLOAD = {
  name: "Jane Analyst",
  linkedin_url: "https://www.linkedin.com/in/jane-analyst",
  location: { city: "Provo", state: "Utah", country: "United States" },
  experiences: [
    {
      title: "APM",
      company: { name: "Acme", linkedin_company_id: "555" },
      is_current: true,
      location_raw: "Provo, Utah, United States",
    },
  ],
  education: [{ school_name: "BYU", start_year: 2022 }],
};

function janeRow(overrides: Record<string, unknown> = {}) {
  const payload_hash = hashPayload(JANE_PAYLOAD as never);
  return {
    id: 301,
    linkedin_url: "https://www.linkedin.com/in/jane-analyst",
    payload: JANE_PAYLOAD,
    payload_schema_version: 1,
    payload_hash,
    resolved: null,
    ...overrides,
  };
}

function resolverResponder(prospects: unknown[]): Responder {
  return (state) => {
    if (state.table === "bundle_prospects" && state.op === "select") return { data: prospects };
    if (state.table === "companies" && state.op === "select") return { data: [ACME] };
    if (state.table === "locations" && state.op === "select") return { data: [PROVO] };
    if (state.table === "schools" && state.op === "select") return { data: [{ id: 30, name: "BYU" }] };
    if (state.table === "company_locations") return { data: [] };
    if (state.table.startsWith("rpc:")) return { data: 1 };
    return { data: [] };
  };
}

// ── readProspectResolution ─────────────────────────────────────────────

describe("readProspectResolution", () => {
  const valid: BundleProspectResolution = {
    payload_hash: "h1",
    profile_location_id: 55,
    experiences: [{ company_id: 10, location_id: 20, location_source: "experience" }],
    education: [{ school_id: 30 }],
  };

  it("returns the resolution when the hash matches", () => {
    expect(readProspectResolution(valid, "h1")).toEqual(valid);
  });

  it("treats a payload_hash mismatch as stale", () => {
    expect(readProspectResolution(valid, "h2")).toBeNull();
  });

  it("rejects malformed shapes", () => {
    expect(readProspectResolution(null, "h1")).toBeNull();
    expect(readProspectResolution({ payload_hash: "h1" }, "h1")).toBeNull();
    expect(
      readProspectResolution({ ...valid, experiences: [{ company_id: "not-a-number" }] }, "h1"),
    ).toBeNull();
  });
});

// ── resolveBundleChunk ─────────────────────────────────────────────────

describe("resolveBundleChunk", () => {
  it("resolves a stale prospect and writes the snapshot through the RPC", async () => {
    const { client, calls } = createMockClient(resolverResponder([janeRow()]));
    const result = await resolveBundleChunk(client, BUNDLE, { afterId: 0 });

    expect(result.done).toBe(true);
    expect(result.resolved).toBe(1);
    expect(result.skipped).toEqual([]);

    const rpc = byTable(calls, "rpc:apply_bundle_resolutions", "rpc")[0];
    expect(rpc).toBeTruthy();
    const rows = (rpc.payload as { p_rows: Array<{ id: number; resolved: BundleProspectResolution }> }).p_rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(301);
    expect(rows[0].resolved.payload_hash).toBe(janeRow().payload_hash);
    // Experience resolved to the prefetched company + its city-grain office.
    expect(rows[0].resolved.experiences).toEqual([
      { company_id: 10, location_id: 20, location_source: "experience" },
    ]);
    expect(rows[0].resolved.education).toEqual([{ school_id: 30 }]);
    expect(rows[0].resolved.profile_location_id).toBe(20);

    // Pass 1 established the office it resolved.
    const officeUpsert = byTable(calls, "company_locations", "upsert")[0];
    expect(officeUpsert.payload as unknown[]).toEqual([{ company_id: 10, location_id: 20, source: "scraped" }]);
  });

  it("skips hash-current rows without re-resolving or writing", async () => {
    const row = janeRow();
    const current = {
      ...row,
      resolved: {
        payload_hash: row.payload_hash,
        profile_location_id: 20,
        experiences: [{ company_id: 10, location_id: 20, location_source: "experience" }],
        education: [{ school_id: 30 }],
      },
    };
    const { client, calls } = createMockClient(resolverResponder([current]));
    const result = await resolveBundleChunk(client, BUNDLE, { afterId: 0 });

    expect(result.done).toBe(true);
    expect(result.resolved).toBe(0);
    expect(byTable(calls, "rpc:apply_bundle_resolutions")).toHaveLength(0);
    expect(byTable(calls, "companies")).toHaveLength(0);
  });

  it("reports unparseable payloads and keeps going", async () => {
    const bad = janeRow({ id: 999, payload: { nope: true }, payload_hash: "x" });
    const { client } = createMockClient(resolverResponder([bad, janeRow()]));
    const result = await resolveBundleChunk(client, BUNDLE, { afterId: 0 });

    expect(result.resolved).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain("invalid_payload");
  });

  it("hands back a cursor on a full chunk", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => janeRow({ id: i + 1 }));
    const { client } = createMockClient(resolverResponder(rows));
    const result = await resolveBundleChunk(client, BUNDLE, { afterId: 0, chunkSize: 5 });

    expect(result.done).toBe(false);
    expect(result.nextAfterId).toBe(5);
  });
});

// ── markBundleResolved ─────────────────────────────────────────────────

describe("markBundleResolved", () => {
  it("stamps resolved_version guarded on the version it resolved", async () => {
    const { client, calls } = createMockClient(() => ({ data: [] }));
    await markBundleResolved(client, { id: 1, version: 3 });
    const update = byTable(calls, "data_bundles", "update")[0];
    expect((update.payload as Record<string, unknown>).resolved_version).toBe(3);
    expect(update.filters.filter((f) => f.method === "eq").map((f) => f.args)).toEqual([
      ["id", 1],
      ["version", 3],
    ]);
  });
});
