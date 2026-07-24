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
  (_state: string, opts?: { includeModify?: boolean; includeCalendar?: boolean }) =>
    `https://accounts.google.com/o/oauth2/v2/auth?modify=${opts?.includeModify ? "1" : "0"}&cal=${opts?.includeCalendar ? "1" : "0"}`,
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

function lastIncludeCalendar(): boolean | undefined {
  const calls = getAuthUrlSpy.mock.calls;
  return calls.length ? calls[calls.length - 1][1]?.includeCalendar : undefined;
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

  it("connected without the modify scope -> NO modify on a normal reconnect", async () => {
    state.conn = { modify_scope_granted: false, premium_enabled: true };
    await call();
    expect(lastIncludeModify()).toBe(false);
  });

  // CAR-131: admin Premium on + ?upgrade=1 requests modify even when not yet granted.
  it("upgrade reconnect (?upgrade=1) with Premium on -> requests gmail.modify", async () => {
    state.conn = { modify_scope_granted: false, premium_enabled: true };
    const res = await call("?upgrade=1");
    expect(lastIncludeModify()).toBe(true);
    expect(res.headers.get("location")).toContain("modify=1");
  });

  it("upgrade reconnect with Premium off -> still NO modify", async () => {
    state.conn = { modify_scope_granted: false, premium_enabled: false };
    await call("?upgrade=1");
    expect(lastIncludeModify()).toBe(false);
  });

  it("DB read error -> ABORTS to the settings error page, never builds a scope-light consent URL", async () => {
    state.connError = { message: "connection reset by peer" };
    const res = await call();
    expect(getAuthUrlSpy).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("/settings?gmail=error");
  });

  // CAR-100: every consent screen requests Gmail + Calendar together, so the
  // user passes through Google's consent (and the unverified-app warning) once.
  it("free / new user -> still requests Calendar alongside Gmail", async () => {
    state.conn = null;
    const res = await call();
    expect(lastIncludeCalendar()).toBe(true);
    expect(res.headers.get("location")).toContain("cal=1");
  });

  it("premium user -> requests Calendar too (both gmail.modify and calendar)", async () => {
    state.conn = { modify_scope_granted: true, premium_enabled: true };
    await call();
    expect(lastIncludeCalendar()).toBe(true);
    expect(lastIncludeModify()).toBe(true);
  });
});

// CAR-177 (F35): the auth side of the returnTo open-redirect guard. The
// callback re-validates independently (gmail-callback-security.test.ts), but
// a hostile returnTo should never be minted into state in the first place.
describe("GET /api/gmail/auth — returnTo filtering (CAR-50 / CAR-177)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1" };
    state.conn = null;
    state.connError = null;
  });

  const mintedState = () => {
    const raw = getAuthUrlSpy.mock.calls.at(-1)?.[0] as string;
    return JSON.parse(Buffer.from(raw, "base64url").toString()) as Record<string, unknown>;
  };

  it("a same-origin relative path rides along in state", async () => {
    await call("?returnTo=%2Fcontacts%3Fonboarding%3D1");
    expect(mintedState().returnTo).toBe("/contacts?onboarding=1");
  });

  it("protocol-relative and absolute URLs are dropped from state", async () => {
    for (const bad of ["%2F%2Fevil.example", "https%3A%2F%2Fevil.example%2Fphish", "javascript%3Aalert(1)"]) {
      await call(`?returnTo=${bad}`);
      expect(mintedState(), `returnTo=${decodeURIComponent(bad)} must not be minted`).not.toHaveProperty("returnTo");
    }
  });
});
