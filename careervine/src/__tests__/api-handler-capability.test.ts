import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-103: the requireCapability gate on withApiHandler. Verifies allow/deny,
 * and that an authOptional route with no user fails CLOSED to 403 (never a 500,
 * and never calling the resolver with an undefined id).
 */

let authedUser: Record<string, unknown> | null = { id: "u-1", app_metadata: {} };
const resolveCapabilitiesMock = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/capabilities", () => ({
  resolveCapabilities: (...args: unknown[]) => resolveCapabilitiesMock(...args),
}));

import { withApiHandler } from "@/lib/api-handler";

function makeRequest() {
  return {
    method: "GET",
    nextUrl: new URL("http://localhost:3000/api/test"),
    url: "http://localhost:3000/api/test",
    headers: new Headers(),
    json: async () => ({}),
  } as never;
}

async function callWith(config: Record<string, unknown>) {
  const route = withApiHandler({ handler: async () => ({ ok: true }), ...config } as never);
  const res = await route(makeRequest(), { params: Promise.resolve({}) });
  return { status: res.status, data: await res.json() };
}

describe("withApiHandler requireCapability gate (CAR-103)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1", app_metadata: {} };
  });

  it("allows the request when the user has the capability", async () => {
    resolveCapabilitiesMock.mockResolvedValue(new Set(["mailbox:read"]));
    const { status, data } = await callWith({ requireCapability: "mailbox:read" });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
  });

  it("403s when the capability is absent", async () => {
    resolveCapabilitiesMock.mockResolvedValue(new Set(["inbox:premium"]));
    const { status, data } = await callWith({ requireCapability: "mailbox:read" });
    expect(status).toBe(403);
    expect(data.error).toBe("Forbidden");
    expect(data.capability).toBe("mailbox:read");
  });

  it("null user on an authOptional route -> 403 not 500, and never calls the resolver", async () => {
    authedUser = null;
    const { status } = await callWith({ authOptional: true, requireCapability: "mailbox:read" });
    expect(status).toBe(403);
    expect(resolveCapabilitiesMock).not.toHaveBeenCalled();
  });

  it("does not gate (and never resolves) when requireCapability is unset", async () => {
    const { status } = await callWith({});
    expect(status).toBe(200);
    expect(resolveCapabilitiesMock).not.toHaveBeenCalled();
  });
});
