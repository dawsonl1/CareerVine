import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/discovery/candidates/[id]/dismiss (CAR-135 / R4.8): dismissing a
 * candidate must also redact its scraped third-party payload, keeping only the
 * identity tombstone that makes the dismiss sticky.
 */

let authedUser: Record<string, unknown> = { id: "user-1", app_metadata: {} };

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

const updateSpy = vi.fn();
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ count: 1, error: null }).then(resolve);
      chain.update = (payload: unknown, opts: unknown) => {
        updateSpy(payload, opts);
        return chain;
      };
      chain.eq = () => chain;
      return chain;
    },
  })),
}));

import { POST } from "@/app/api/discovery/candidates/[id]/dismiss/route";

function makeRequest() {
  return {
    method: "POST",
    nextUrl: new URL("http://localhost:3000/api/discovery/candidates/5/dismiss"),
    headers: new Headers(),
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  authedUser = { id: "user-1", app_metadata: {} };
});

describe("dismiss candidate redaction", () => {
  it("marks the row dismissed and clears the scraped payload", async () => {
    const response = await POST(makeRequest() as never, { params: Promise.resolve({ id: "5" }) } as never);
    expect(response.status).toBe(200);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [payload, opts] = updateSpy.mock.calls[0];
    expect(payload).toMatchObject({
      status: "dismissed",
      raw: {},
      headline: null,
      location: null,
      photo_url: null,
      position: null,
    });
    expect(opts).toEqual({ count: "exact" });
  });
});
