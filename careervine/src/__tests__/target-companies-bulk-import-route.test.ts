/**
 * POST /api/target-companies/bulk-import — targeting is a hand-set field
 * (CAR-258).
 *
 * The route used to write `is_targeted: true` on every existing row, so
 * re-running the ~337-company APM sheet silently re-targeted companies the user
 * had untargeted by hand. Only two lines in the whole codebase write
 * `is_targeted = false` (`pipeline-queries.ts` and `company-queries.ts`), and
 * both are user actions, so nothing an ops re-import does should reverse one.
 *
 * These drive the REAL POST handler with extension auth and the company lookup
 * mocked, and assert on the payload that reaches the client — asserting the
 * absence of a key, which is the whole regression.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Chained-builder mock, shared by the auth stub and the handler ──────────
interface QueryState {
  table: string;
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}
type Responder = (state: QueryState) => { data?: unknown; error?: { message: string } | null } | undefined;

let respond: Responder = () => ({ data: null });
let calls: QueryState[] = [];

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
    eq: chain("eq"),
    is: chain("is"),
    async single() { return resolve(); },
    async maybeSingle() { return resolve(); },
    then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
  });
  return builder;
}

vi.mock("@/lib/extension-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-auth")>();
  return {
    ...actual,
    getExtensionAuth: vi.fn(async () => ({
      user: { id: "user-1" },
      supabase: { from: (t: string) => makeBuilder(t) },
    })),
  };
});

// The identity match chain is company-helpers' business, not this route's.
vi.mock("@/lib/company-helpers", () => ({
  findOrCreateCompany: vi.fn(async () => ({ id: 7, name: "Stripe", possible_duplicate_of: null })),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/target-companies/bulk-import/route";

function makeReq() {
  return new NextRequest("https://www.careervine.app/api/target-companies/bulk-import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // No `tier`: CAR-251 retired target_companies.tier, dropping the column and
    // the route's write of it. A sheet may still carry the key, and the route
    // ignores it.
    body: JSON.stringify({ companies: [{ name: "Stripe", priority_score: 9 }] }),
  });
}

/** The write the handler issued against target_companies, if any. */
function targetWrite() {
  return calls.find((c) => c.table === "target_companies" && c.op !== "select");
}

describe("POST /api/target-companies/bulk-import — targeting is hand-set", () => {
  beforeEach(() => {
    calls = [];
  });

  it("does NOT re-target an existing row the user untargeted by hand", async () => {
    respond = (state) => {
      if (state.table === "target_companies" && state.op === "select") return { data: { id: 42 } };
      return { data: null };
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);

    const write = targetWrite();
    expect(write?.op).toBe("update");
    // The regression, stated as the absence of a key: any `is_targeted` in this
    // payload re-targets a company the user deliberately dropped.
    expect(write?.payload).not.toHaveProperty("is_targeted");
  });

  it("still refreshes the research fields from the sheet", async () => {
    respond = (state) => {
      if (state.table === "target_companies" && state.op === "select") return { data: { id: 42 } };
      return { data: null };
    };
    await POST(makeReq());

    expect(targetWrite()?.payload).toMatchObject({
      priority_score: 9,
      program_name: null,
      app_window_text: null,
    });
  });

  it("leaves status and next_app_date alone, as it always has", async () => {
    respond = (state) => {
      if (state.table === "target_companies" && state.op === "select") return { data: { id: 42 } };
      return { data: null };
    };
    await POST(makeReq());

    const payload = targetWrite()?.payload;
    expect(payload).not.toHaveProperty("status");
    expect(payload).not.toHaveProperty("next_app_date");
  });

  it("still targets a company that has no row yet", async () => {
    // The first import must keep working: the insert omits `is_targeted` and
    // takes the column default (true), so a fresh sheet load targets everything.
    respond = (state) => {
      if (state.table === "target_companies" && state.op === "select") return { data: null };
      if (state.table === "target_companies" && state.op === "insert") return { data: { id: 43 } };
      return { data: null };
    };
    const res = await POST(makeReq());
    expect(res.status).toBe(200);

    const write = targetWrite();
    expect(write?.op).toBe("insert");
    expect(write?.payload).toMatchObject({ user_id: "user-1", company_id: 7 });
    expect(write?.payload).not.toHaveProperty("is_targeted");
  });
});
