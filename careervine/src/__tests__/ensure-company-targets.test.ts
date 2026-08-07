/**
 * `ensureCompanyTargets` — targeting a deliberately-added person's current
 * employer (CAR-263).
 *
 * Three rules carry the feature, and each has a specific way of going wrong:
 *
 * 1. Missing rows only. If this ever writes `is_targeted`, adding a contact
 *    silently revives a company the user untargeted by hand — CAR-258's bug at a
 *    new call site.
 * 2. Company-wide scope only, so an office-level target row is not mistaken for
 *    the company-wide one (that would leave the company untargeted while the
 *    helper reports success).
 * 3. It never throws. A contact save must not fail because target bookkeeping
 *    did, including on the 23505 two concurrent saves race into.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureCompanyTargets } from "@/lib/company-helpers";

interface QueryState {
  table: string;
  op: "select" | "insert";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}
type Responder = (state: QueryState) => { data?: unknown; error?: { code?: string; message: string } | null } | undefined;

function mockClient(respond: Responder) {
  const calls: QueryState[] = [];
  const client = {
    from(table: string) {
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
        eq: chain("eq"),
        is: chain("is"),
        in: chain("in"),
        limit: chain("limit"),
        then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
      });
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const insertOf = (calls: QueryState[]) => calls.find((c) => c.op === "insert");

afterEach(() => vi.restoreAllMocks());

describe("ensureCompanyTargets", () => {
  it("creates a target for a company that has none", async () => {
    const { client, calls } = mockClient((s) => (s.op === "select" ? { data: [] } : { data: null }));
    const created = await ensureCompanyTargets(client, "user-1", [7, 9]);

    expect(created).toBe(2);
    expect(insertOf(calls)?.payload).toEqual([
      { user_id: "user-1", company_id: 7 },
      { user_id: "user-1", company_id: 9 },
    ]);
  });

  it("omits is_targeted and status so both take their column defaults", async () => {
    const { client, calls } = mockClient((s) => (s.op === "select" ? { data: [] } : { data: null }));
    await ensureCompanyTargets(client, "user-1", [7]);

    const rows = insertOf(calls)?.payload as Array<Record<string, unknown>>;
    expect(rows[0]).not.toHaveProperty("is_targeted");
    expect(rows[0]).not.toHaveProperty("status");
  });

  it("does NOT touch a company the user untargeted by hand", async () => {
    // The row exists at is_targeted = false. Writing anything here would revive
    // it, which is exactly what CAR-258 removed from the bulk import.
    const { client, calls } = mockClient((s) =>
      s.op === "select" ? { data: [{ company_id: 7 }] } : { data: null },
    );
    const created = await ensureCompanyTargets(client, "user-1", [7]);

    expect(created).toBe(0);
    expect(insertOf(calls)).toBeUndefined();
  });

  it("inserts only the companies missing a row, not the whole list", async () => {
    const { client, calls } = mockClient((s) =>
      s.op === "select" ? { data: [{ company_id: 7 }] } : { data: null },
    );
    const created = await ensureCompanyTargets(client, "user-1", [7, 9]);

    expect(created).toBe(1);
    expect(insertOf(calls)?.payload).toEqual([{ user_id: "user-1", company_id: 9 }]);
  });

  it("looks only at company-wide rows, so an office target is not mistaken for one", async () => {
    const { client, calls } = mockClient((s) => (s.op === "select" ? { data: [] } : { data: null }));
    await ensureCompanyTargets(client, "user-1", [7]);

    const read = calls.find((c) => c.op === "select");
    expect(read?.filters).toContainEqual({ method: "is", args: ["location_id", null] });
    expect(read?.filters).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
  });

  it("dedupes repeated ids and ignores non-finite ones", async () => {
    const { client, calls } = mockClient((s) => (s.op === "select" ? { data: [] } : { data: null }));
    const created = await ensureCompanyTargets(client, "user-1", [7, 7, NaN]);

    expect(created).toBe(1);
    expect(insertOf(calls)?.payload).toEqual([{ user_id: "user-1", company_id: 7 }]);
  });

  it("does nothing, and reads nothing, for an empty list", async () => {
    const { client, calls } = mockClient(() => ({ data: [] }));
    expect(await ensureCompanyTargets(client, "user-1", [])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("swallows the 23505 two concurrent saves race into", async () => {
    // Losing that race means the row exists, which is the goal.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = mockClient((s) =>
      s.op === "select"
        ? { data: [] }
        : { error: { code: "23505", message: "duplicate key value" } },
    );
    await expect(ensureCompanyTargets(client, "user-1", [7])).resolves.toBe(0);
  });

  it("never throws at the caller, so a contact save cannot fail on bookkeeping", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = mockClient(() => ({ error: { message: "connection lost" } }));

    await expect(ensureCompanyTargets(client, "user-1", [7])).resolves.toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });
});
