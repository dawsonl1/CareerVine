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

vi.mock("@/lib/analytics/server", () => mockAnalyticsServerModule());

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

vi.mock("@/lib/supabase/server-client", () =>
  mockServerClientModule({ user: () => ({ id: "user-1" }), client: () => ({ from: (t: string) => makeBuilder(t) }) }),
);

import { NextRequest } from "next/server";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServerClientModule } from "./helpers/mock-supabase";
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
    // Must exceed SYNC_CLAIM_MS (2 min): a backup firing inside a
    // timeout-killed call's claim window would be skipped as claimed.
    expect(opts).toMatchObject({ delaySeconds: 180 });
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

/**
 * CAR-207: the route reads with maybeSingle() and then inserts, so two
 * concurrent subscribes both see no row and both insert. UNIQUE (user_id,
 * bundle_id) refuses the loser with 23505, which the blanket `if (error)` arm
 * turned into a 500. The client's catch then toasted "Could not create your
 * subscription" over a subscription that existed and was already syncing.
 */
describe("POST /api/bundles/subscribe — the UNIQUE race (CAR-207)", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
  });

  /** The loser's view: read finds nothing, insert hits the constraint, re-read
   *  finds the winner's row. */
  function raceRespond(reReadResult: { data?: unknown; error?: { message: string } | null }) {
    let selects = 0;
    return (state: QueryState) => {
      if (state.table === "data_bundles") return { data: BUNDLE };
      if (state.table === "bundle_subscriptions" && state.op === "select") {
        selects += 1;
        // First: the pre-insert existence probe, which raced and saw nothing.
        // Second: the post-conflict re-read.
        return selects === 1 ? { data: null } : reReadResult;
      }
      if (state.table === "bundle_subscriptions" && state.op === "insert") {
        return { data: null, error: { message: "duplicate key value", code: "23505" } as never };
      }
      return { data: null };
    };
  }

  it("reports the winner's subscription as success instead of a 500", async () => {
    respond = raceRespond({ data: { id: 77, status: "active", synced_version: 0 } });

    const res = await POST(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.subscription).toMatchObject({ id: 77, status: "active" });
    // The backup sync still gets enqueued against the row that exists, so a
    // loser whose client loop dies is covered exactly like a winner's.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect((enqueueMock.mock.calls[0] as unknown[])[0]).toEqual([77]);
  });

  it("still fails loudly when the conflict is real but the row cannot be found", async () => {
    // A 23505 with nothing to read back is not the benign race, so the honest
    // answer is still an error rather than a fabricated success.
    respond = raceRespond({ data: null });

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("leaves every other insert failure a 500", async () => {
    respond = (state) => {
      if (state.table === "data_bundles") return { data: BUNDLE };
      if (state.table === "bundle_subscriptions" && state.op === "select") return { data: null };
      if (state.table === "bundle_subscriptions" && state.op === "insert") {
        return { data: null, error: { message: "deadlock detected", code: "40P01" } as never };
      }
      return { data: null };
    };

    const res = await POST(makeReq());

    expect(res.status).toBe(500);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
