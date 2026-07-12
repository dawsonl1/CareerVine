import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102 (review N3): GET /api/gmail/auth decides whether to request the
 * restricted gmail.modify scope from the RAW entitlement flags
 * (modify_scope_granted && premium_enabled), read directly from the connection
 * row — NOT via resolveCapabilities, which fails closed to the empty set and
 * would silently downgrade a premium user to sensitive-only scopes on a
 * transient DB blip. On a read error the connect ABORTS (redirect to the
 * settings error page) rather than proceeding scope-light.
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };
const state: { conn: unknown; connError: unknown } = { conn: null, connError: null };
const getAuthUrlSpy = vi.fn(
  (_state: string, opts?: { includeModify?: boolean }) =>
    `https://accounts.google.com/o/oauth2/v2/auth?modify=${opts?.includeModify ? "1" : "0"}`,
);

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/gmail", () => ({
  getAuthUrl: (...a: unknown[]) => getAuthUrlSpy(...(a as [string, { includeModify?: boolean }])),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: state.conn, error: state.connError }),
      };
      return b;
    },
  })),
}));

import { GET } from "@/app/api/gmail/auth/route";

function makeRequest(search = "") {
  const url = `http://localhost:3000/api/gmail/auth${search}`;
  return {
    method: "GET",
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
  } as never;
}

async function call(search = "") {
  const res = await GET(makeRequest(search), { params: Promise.resolve({}) });
  return res as unknown as { status: number; headers: Headers };
}

function lastIncludeModify(): boolean | undefined {
  const calls = getAuthUrlSpy.mock.calls;
  return calls.length ? calls[calls.length - 1][1]?.includeModify : undefined;
}

describe("GET /api/gmail/auth — modify-scope decision (CAR-102 N3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1" };
    state.conn = null;
    state.connError = null;
  });

  it("premium (modify granted + premium enabled) -> requests gmail.modify", async () => {
    state.conn = { modify_scope_granted: true, premium_enabled: true };
    const res = await call();
    expect(getAuthUrlSpy).toHaveBeenCalled();
    expect(lastIncludeModify()).toBe(true);
    expect(res.headers.get("location")).toContain("modify=1");
  });

  it("premium DISABLED by admin (modify granted, premium_enabled=false) -> NO modify", async () => {
    state.conn = { modify_scope_granted: true, premium_enabled: false };
    await call();
    expect(lastIncludeModify()).toBe(false);
  });

  it("premium_enabled null (never set) defaults to enabled -> modify follows the granted flag", async () => {
    state.conn = { modify_scope_granted: true, premium_enabled: null };
    await call();
    expect(lastIncludeModify()).toBe(true);
  });

  it("free / new user (no connection row yet) -> NO modify (sensitive-only)", async () => {
    state.conn = null;
    await call();
    expect(lastIncludeModify()).toBe(false);
  });

  it("connected without the modify scope -> NO modify even if premium_enabled", async () => {
    state.conn = { modify_scope_granted: false, premium_enabled: true };
    await call();
    expect(lastIncludeModify()).toBe(false);
  });

  it("DB read error -> ABORTS to the settings error page, never builds a scope-light consent URL", async () => {
    state.connError = { message: "connection reset by peer" };
    const res = await call();
    expect(getAuthUrlSpy).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("/settings?gmail=error");
  });
});
