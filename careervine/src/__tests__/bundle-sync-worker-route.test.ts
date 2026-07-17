/**
 * CAR-112: the bundle-sync worker must never let a slow apply chunk run past
 * Vercel's 60s maxDuration. A hard-kill skips the graceful re-enqueue and makes
 * QStash retry the whole batch 3×. runWithResponseDeadline backstops the
 * processing: on the deadline it re-enqueues the input batch and returns 200,
 * turning a batch-wide retry storm into one clean re-enqueue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const processMock = vi.fn();
const enqueueMock = vi.fn<(...a: unknown[]) => Promise<number>>(async () => 1);
vi.mock("@/lib/bundle-queue", () => ({
  processSubscriptionsUnderBudget: (...a: unknown[]) => processMock(...a),
  enqueueBundleSyncJobs: (...a: unknown[]) => enqueueMock(...a),
  // Tiny deadline so the backstop path is exercised without a real 55s wait.
  SYNC_RESPONSE_DEADLINE_MS: 20,
}));
vi.mock("@/lib/bundle-sync", () => ({ SYNC_CLAIM_MS: 120_000 }));
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({}),
}));
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify() {
      return Promise.resolve(true);
    }
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/queue/bundle-sync/route";

const req = (ids: number[]) =>
  new NextRequest("https://www.careervine.app/api/queue/bundle-sync", {
    method: "POST",
    headers: { "upstash-signature": "sig" },
    body: JSON.stringify({ subscriptionIds: ids }),
  });

beforeEach(() => {
  processMock.mockReset();
  enqueueMock.mockClear();
  enqueueMock.mockResolvedValue(1);
});

describe("POST /api/queue/bundle-sync", () => {
  it("returns processing counts on the happy path (backstop never fires)", async () => {
    processMock.mockResolvedValue({
      completed: [1],
      remaining: [],
      skipped: [],
      failed: [],
      applied: 5,
    });
    const res = await POST(req([1]));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ completed: 1, applied: 5 });
    expect(body.timedOut).toBeUndefined();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("backstops a run that overruns the deadline: re-enqueues the whole batch, 200", async () => {
    processMock.mockImplementation(() => new Promise(() => {})); // never settles
    const res = await POST(req([1, 2, 3]));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.timedOut).toBe(true);
    expect(body.requeued).toBe(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      [1, 2, 3],
      expect.stringContaining("/api/queue/bundle-sync"),
    );
  });

  it("short-circuits an empty batch without touching the processor", async () => {
    const res = await POST(req([]));
    expect((await res.json()).processed).toBe(0);
    expect(processMock).not.toHaveBeenCalled();
  });
});
