/**
 * CAR-78: POST /api/bundles/apply loops applyBundleDelta steps in-process
 * under a wall-clock budget, so a sync completes in 1–2 round trips instead
 * of one HTTP call per chunk. Contract stays chunk-compatible: a budget
 * (or lost-claim) exit returns the cursor + claimToken exactly like the old
 * single-chunk response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ApplyStepResult } from "@/lib/bundle-sync";

const applyMock = vi.fn<(...args: unknown[]) => Promise<ApplyStepResult>>();
const claimMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const releaseMock = vi.fn(async () => undefined);

vi.mock("@/lib/bundle-sync", () => ({
  applyBundleDelta: (...args: unknown[]) => applyMock(...args),
  claimSubscriptionSync: (...args: unknown[]) => claimMock(...args),
  releaseSubscriptionSync: (...args: unknown[]) => releaseMock(),
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn(async () => undefined),
}));

// Minimal chained-builder mock behind createSupabaseServerClient — the route
// only reads data_bundles and bundle_subscriptions.
function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => () => builder;
  Object.assign(builder, {
    select: chain()(),
  });
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    async maybeSingle() {
      if (table === "data_bundles") {
        return { data: { id: 1, slug: "apm", name: "APM", version: 3, resolved_version: 3 }, error: null };
      }
      if (table === "bundle_subscriptions") {
        return {
          data: { id: 7, user_id: "user-1", bundle_id: 1, status: "active", synced_version: 0 },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  return self;
}

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (t: string) => makeBuilder(t),
  })),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/bundles/apply/route";

function step(partial: Partial<ApplyStepResult>): ApplyStepResult {
  return {
    done: false,
    nextCursor: null,
    pinnedVersion: 3,
    applied: 0,
    removedContacts: 0,
    orphanedLinks: 0,
    skipped: [],
    path: "merge",
    ...partial,
  };
}

function makeReq(body: Record<string, unknown> = { bundleId: 1 }) {
  return new NextRequest("https://www.careervine.app/api/bundles/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  applyMock.mockReset();
  claimMock.mockReset();
  releaseMock.mockClear();
  let token = 0;
  claimMock.mockImplementation(async () => `token-${++token}`);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/bundles/apply (CAR-78 in-process loop)", () => {
  it("runs multiple steps in one call, sums totals, and releases the claim on done", async () => {
    applyMock
      .mockResolvedValueOnce(step({ applied: 150, nextCursor: { phase: "apply", afterId: 150 } }))
      .mockResolvedValueOnce(step({ applied: 150, nextCursor: { phase: "remove", afterId: 0 } }))
      .mockResolvedValueOnce(step({ applied: 0, removedContacts: 2, done: true }));

    const res = await POST(makeReq());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(applyMock).toHaveBeenCalledTimes(3);
    expect(body.done).toBe(true);
    expect(body.applied).toBe(300);
    expect(body.removedContacts).toBe(2);
    expect(body.claimToken).toBeUndefined();
    expect(releaseMock).toHaveBeenCalledTimes(1);
    // Initial claim + one CAS renewal between each pair of steps.
    expect(claimMock).toHaveBeenCalledTimes(3);
  });

  it("stops at the budget and hands back cursor + claimToken like a single chunk", async () => {
    applyMock.mockImplementation(async () => {
      // Each "step" burns 40s of wall clock — past the 35s budget.
      vi.setSystemTime(Date.now() + 40_000);
      return step({ applied: 150, nextCursor: { phase: "apply", afterId: 150 } });
    });

    const res = await POST(makeReq());
    const body = await res.json();

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(body.done).toBe(false);
    expect(body.nextCursor).toEqual({ phase: "apply", afterId: 150 });
    expect(body.claimToken).toBe("token-1");
    expect(body.applied).toBe(150);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it("stops looping when the claim renewal fails instead of interleaving", async () => {
    claimMock.mockReset();
    claimMock
      .mockResolvedValueOnce("token-1") // initial claim
      .mockResolvedValueOnce(null); // renewal stolen/released
    applyMock.mockResolvedValue(step({ applied: 150, nextCursor: { phase: "apply", afterId: 150 } }));

    const res = await POST(makeReq());
    const body = await res.json();

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(body.done).toBe(false);
    expect(body.claimToken).toBe("token-1");
  });

  it("surfaces the step's path in the response (CAR-78 instrumentation)", async () => {
    applyMock.mockResolvedValueOnce(step({ applied: 900, done: true, path: "fast" }));
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.path).toBe("fast");
  });

  it("releases the claim and rethrows when a step throws", async () => {
    applyMock.mockRejectedValueOnce(new Error("chunk exploded"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("409s when another driver holds the claim", async () => {
    claimMock.mockReset();
    claimMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(409);
    expect(applyMock).not.toHaveBeenCalled();
  });
});
