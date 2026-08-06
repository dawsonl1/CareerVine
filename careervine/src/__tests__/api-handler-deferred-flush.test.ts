/**
 * The wrapper's background work must not sit on the response's critical path
 * (CAR-229).
 *
 * `withApiHandler` queues two kinds of side work on every request — analytics
 * captures and the throttled `users` stamp (`web_last_seen_at` + timezone) —
 * and used to `await Promise.allSettled(...)` them in `finally`. That put a
 * Supabase round trip in front of the response bytes of EVERY API call, on all
 * ~91 wrapped routes.
 *
 * Two properties are pinned here, and the pair is the point: it is trivial to
 * make the response fast by dropping the work, and trivial to keep the work by
 * blocking the response. Neither alone is the fix.
 *
 *   1. the response resolves BEFORE the stamp write settles, and
 *   2. the stamp write is still handed to `after()`, so the platform keeps the
 *      invocation alive until it completes.
 *
 * Plus the fallback: with no request scope (`after()` throws), the wrapper must
 * go back to awaiting rather than leaking a floating promise. That path is what
 * keeps the CAR-68 extension-stamp assertions in api-handler.test.ts honest —
 * they run in this same scope-less harness.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { mockServerClientModule } from "./helpers/mock-supabase";

// ── A controllable stand-in for the throttled users UPDATE ─────────────

type Gate = {
  /** True once the fake DB write has resolved. */
  settled: boolean;
  release: () => void;
  promise: Promise<{ error: null }>;
};

function makeGate(): Gate {
  const gate = {
    settled: false,
    release: () => {},
    promise: null as unknown as Promise<{ error: null }>,
  };
  gate.promise = new Promise<{ error: null }>((resolve) => {
    gate.release = () => {
      gate.settled = true;
      resolve({ error: null });
    };
  });
  return gate;
}

let gate: Gate;
/** Tables the wrapper's background work touched, in order. */
let touchedTables: string[];

vi.mock("@/lib/supabase/server-client", () =>
  mockServerClientModule({
    user: () => ({ id: "user-123", email: "test@example.com" }),
    client: () => ({
      from: (table: string) => {
        touchedTables.push(table);
        return { update: () => ({ eq: () => ({ or: () => gate.promise }) }) };
      },
    }),
  }),
);

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 59, resetAt: null }),
}));

// ── `after()` under our control ───────────────────────────────────────
//
// Real `after()` throws when there is no request scope, which is exactly the
// state a unit test runs in — so the scope-available branch is unreachable
// without doubling it. Everything else in next/server passes through, because
// the wrapper builds its responses from the real NextResponse.

const afterSpy = vi.fn<(task: Promise<unknown>) => void>();
let afterAvailable = true;

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: Promise<unknown>) => {
      if (!afterAvailable) {
        throw new Error("`after` was called outside a request scope.");
      }
      afterSpy(task);
    },
  };
});

import { withApiHandler } from "@/lib/api-handler";

function makeRequest(method: string, body?: unknown) {
  const url = new URL("http://localhost:3000/api/test");
  return {
    method,
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(),
    json:
      body !== undefined
        ? vi.fn().mockResolvedValue(body)
        : vi.fn().mockRejectedValue(new Error("No body")),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the request double in api-handler.test.ts
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  gate = makeGate();
  touchedTables = [];
  afterAvailable = true;
});

describe("withApiHandler background flush (CAR-229)", () => {
  it("resolves the response before the throttled users stamp settles", async () => {
    const handler = withApiHandler({ handler: async () => ({ ok: true }) });

    const response = await handler(makeRequest("GET"));

    expect(response.status).toBe(200);
    // The write was issued...
    expect(touchedTables).toEqual(["users"]);
    // ...but the response did NOT wait for it.
    expect(gate.settled).toBe(false);
  });

  it("still hands that write to after(), so it completes before the freeze", async () => {
    const handler = withApiHandler({ handler: async () => ({ ok: true }) });

    await handler(makeRequest("GET"));

    expect(afterSpy).toHaveBeenCalledTimes(1);

    // The deferred task is the flush: releasing the write settles it, and it
    // never rejects (allSettled), so a failed stamp cannot become an
    // unhandled rejection once nothing is awaiting it in the request frame.
    const deferred = afterSpy.mock.calls[0][0];
    gate.release();
    await expect(deferred).resolves.toEqual([{ status: "fulfilled", value: undefined }]);
    expect(gate.settled).toBe(true);
  });

  it("defers on early-return paths too (validation 400 never ran the handler)", async () => {
    const handlerFn = vi.fn(async () => ({ ok: true }));
    const handler = withApiHandler({
      schema: z.object({ mustHave: z.string() }),
      handler: handlerFn,
    });

    const response = await handler(makeRequest("POST", { wrong: "shape" }));

    expect(response.status).toBe(400);
    expect(handlerFn).not.toHaveBeenCalled();
    expect(afterSpy).toHaveBeenCalledTimes(1);
    expect(gate.settled).toBe(false);
  });

  it("awaits the flush when there is no request scope, instead of dropping it", async () => {
    afterAvailable = false;
    // Settle on a later macrotask, so "the response waited" is observable
    // rather than an artifact of promise-microtask ordering.
    setTimeout(() => gate.release(), 10);

    const handler = withApiHandler({ handler: async () => ({ ok: true }) });
    const response = await handler(makeRequest("GET"));

    expect(response.status).toBe(200);
    expect(afterSpy).not.toHaveBeenCalled();
    expect(gate.settled).toBe(true);
  });

  it("never calls after() when there is nothing queued", async () => {
    const { createSupabaseServerClient } = await import("@/lib/supabase/server-client");
    // No user -> no stamp queued, and the 401 is an early return.
    vi.mocked(createSupabaseServerClient).mockResolvedValueOnce({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { message: "nope" } }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial client double, as elsewhere in this suite
    } as any);

    const handler = withApiHandler({ handler: async () => ({ ok: true }) });
    const response = await handler(makeRequest("GET"));

    expect(response.status).toBe(401);
    expect(touchedTables).toEqual([]);
    expect(afterSpy).not.toHaveBeenCalled();
  });
});
