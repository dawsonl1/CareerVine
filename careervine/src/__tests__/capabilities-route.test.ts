import { describe, it, expect, vi, beforeEach } from "vitest";

/** CAR-103: GET /api/capabilities ships the server-resolved capability set. */

const resolveCapabilitiesMock = vi.fn();
let authedUser: Record<string, unknown> | null = { id: "u-1", app_metadata: {} };

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/capabilities", () => ({
  resolveCapabilities: (...args: unknown[]) => resolveCapabilitiesMock(...args),
}));

import { GET } from "@/app/api/capabilities/route";

function makeRequest() {
  return {
    method: "GET",
    nextUrl: new URL("http://localhost:3000/api/capabilities"),
    url: "http://localhost:3000/api/capabilities",
    headers: new Headers(),
    json: async () => ({}),
  } as never;
}

describe("GET /api/capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1", app_metadata: {} };
  });

  it("returns the user's resolved capabilities as an array", async () => {
    resolveCapabilitiesMock.mockResolvedValue(new Set(["mailbox:read", "inbox:premium"]));
    const res = await GET(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities).toEqual(expect.arrayContaining(["mailbox:read", "inbox:premium"]));
    expect(data.capabilities).toHaveLength(2);
    expect(resolveCapabilitiesMock).toHaveBeenCalledWith("u-1");
  });

  it("401s when unauthenticated (resolver never runs)", async () => {
    authedUser = null;
    const res = await GET(makeRequest(), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
    expect(resolveCapabilitiesMock).not.toHaveBeenCalled();
  });
});
