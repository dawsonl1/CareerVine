/**
 * CAR-47: POST /api/bundles/subscribe enqueues a delayed QStash backup-sync
 * job so a subscriber whose browser dies (or whose apply loop times out)
 * still gets their bundle without waiting for the daily cron.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueMock = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("@/lib/bundle-queue", () => ({
  enqueueBundleSyncJobs: (...args: unknown[]) => enqueueMock(...args),
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn(async () => undefined),
}));

// Chained-builder mock behind createSupabaseServerClient.
interface QueryState {
  table: string;
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Array<{ method: string; args: unknown[] }>;
}
type Responder = (state: QueryState) => { data?: unknown; error?: { message: string } | null } | undefined;

let respond: Responder = () => ({ data: null });

function makeBuilder(table: string) {
  const state: QueryState = { table, op: "select", filters: [] };
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
    eq: chain("eq"), or: chain("or"), is: chain("is"),
    async single() { return resolve(); },
    async maybeSingle() { return resolve(); },
    then(onFulfilled: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(onFulfilled); },
  });
  return builder;
}

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (t: string) => makeBuilder(t),
  })),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/bundles/subscribe/route";

const BUNDLE = { id: 1, name: "APM Data Bundle", version: 3, prospect_count: 2000 };

function makeReq() {
  return new NextRequest("https://www.careervine.app/api/bundles/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundleId: 1 }),
  });
}

describe("POST /api/bundles/subscribe (CAR-47 backup sync)", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
  });

  it("enqueues a delayed backup sync on a new subscription", async () => {
    respond = (state) => {
      if (state.table === "data_bundles") return { data: BUNDLE };
      if (state.table === "bundle_subscriptions" && state.op === "select") return { data: null };
      if (state.table === "bundle_subscriptions" && state.op === "insert") {
        return { data: { id: 33, status: "active", synced_version: 0 } };
      }
      return { data: null };
    };

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const [ids, workerUrl, , opts] = enqueueMock.mock.calls[0] as unknown[];
    expect(ids).toEqual([33]);
    expect(String(workerUrl)).toBe("https://www.careervine.app/api/queue/bundle-sync");
    expect(opts).toMatchObject({ delaySeconds: 120 });
  });

  it("enqueues on reactivation of an unsubscribed row", async () => {
    respond = (state) => {
      if (state.table === "data_bundles") return { data: BUNDLE };
      if (state.table === "bundle_subscriptions" && state.op === "select") {
        return { data: { id: 44, status: "unsubscribed", synced_version: 2 } };
      }
      if (state.table === "bundle_subscriptions" && state.op === "update") {
        return { data: { id: 44, status: "active", synced_version: 0 } };
      }
      return { data: null };
    };

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect((enqueueMock.mock.calls[0] as unknown[])[0]).toEqual([44]);
  });

  it("does NOT enqueue when the subscription is already active", async () => {
    respond = (state) => {
      if (state.table === "data_bundles") return { data: BUNDLE };
      if (state.table === "bundle_subscriptions" && state.op === "select") {
        return { data: { id: 55, status: "active", synced_version: 3 } };
      }
      return { data: null };
    };

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
