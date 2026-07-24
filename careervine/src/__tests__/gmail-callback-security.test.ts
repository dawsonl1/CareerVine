import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-177 (F35): behavioral coverage for the OAuth callback's security
 * branches. The CAR-28 post-program verification proved these guards could be
 * deleted outright (`if (false)` in place of the CSRF userId check) with the
 * full suite staying green — the checks existed but nothing observed them.
 *
 * Every rejection test asserts BOTH halves of the security property:
 *  1. the user lands on the error redirect, and
 *  2. no code exchange and no token persistence happened — the dangerous
 *     outcome of a bypassed guard is an attacker's Google account bound to a
 *     victim's session, and that requires getToken + the upsert to run.
 *
 * Mutation-verified (see CAR-177 PR): disabling the userId check reddens the
 * mismatch tests; deleting the freshness check reddens the expiry test.
 */

const getTokenSpy = vi.fn();
const upsertSpy = vi.fn();

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "victim-user" } }, error: null }),
    },
  }),
}));

vi.mock("@/lib/oauth-helpers", () => ({
  getOAuth2Client: () => ({
    getToken: (...a: unknown[]) => getTokenSpy(...a),
    setCredentials: () => {},
    verifyIdToken: async () => ({ getPayload: () => ({ email: "victim@gmail.com" }) }),
  }),
  encryptOAuthToken: (v: string) => v,
  decryptOAuthToken: (v: string) => v,
}));

vi.mock("@googleapis/oauth2", () => ({
  oauth2: () => ({ userinfo: { get: async () => ({ data: { email: "victim@gmail.com" } }) } }),
}));

vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({ users: { settings: { sendAs: { list: async () => ({ data: { sendAs: [] } }) } } } }),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test chainable stub
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: (values: Record<string, unknown>) => {
          upsertSpy(values);
          return Promise.resolve({ error: null });
        },
        update: () => builder,
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      };
      return builder;
    },
  }),
}));

import { GET } from "@/app/api/gmail/callback/route";

const encodeState = (payload: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(payload)).toString("base64url");

function makeReq(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString();
  const url = `http://localhost:3000/api/gmail/callback${search ? `?${search}` : ""}`;
  return {
    method: "GET",
    url,
    nextUrl: new URL(url),
    headers: new Headers(),
    json: async () => ({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request stub
  } as any;
}

async function call(params: Record<string, string>) {
  const res = await GET(makeReq(params), { params: Promise.resolve({}) });
  const location = res.headers.get("location") ?? "";
  return { status: res.status, location: decodeURIComponent(location) };
}

const VALID_STATE = () => ({ userId: "victim-user", nonce: "n", ts: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  getTokenSpy.mockResolvedValue({
    tokens: {
      access_token: "at",
      refresh_token: "rt",
      id_token: "idt",
      scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send",
      expiry_date: Date.now() + 3600_000,
    },
  });
});

describe("gmail/callback security branches (CAR-177, F35)", () => {
  it("a Google-reported error redirects out before any token exchange", async () => {
    const { location } = await call({ error: "access_denied" });
    expect(location).toContain("gmail=error");
    expect(location).toContain("access_denied");
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("a missing code or state rejects", async () => {
    const cases: Array<Record<string, string>> = [
      { state: encodeState(VALID_STATE()) }, // no code
      { code: "auth-code" }, // no state
    ];
    for (const params of cases) {
      const { location } = await call(params);
      expect(location).toContain("gmail=error");
      expect(location).toContain("Missing code or state");
    }
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("a malformed (non-JSON) state rejects without exchanging the code", async () => {
    const { location } = await call({ code: "auth-code", state: "not!valid@base64url-json" });
    expect(location).toContain("gmail=error");
    expect(location).toContain("Invalid state");
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("CSRF: a state minted for another user rejects — no exchange, no stored tokens", async () => {
    // The attack this guard exists for: the attacker crafts a state carrying
    // their own (or a guessed) userId and lures the victim's session through
    // the callback, binding the attacker's Google account to the victim.
    const forged = encodeState({ userId: "attacker-user", nonce: "n", ts: Date.now() });
    const { location } = await call({ code: "attacker-code", state: forged });
    expect(location).toContain("gmail=error");
    expect(location).toContain("State mismatch");
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("an expired state (>10 min) rejects — no stored tokens", async () => {
    const stale = encodeState({ userId: "victim-user", nonce: "n", ts: Date.now() - 11 * 60 * 1000 });
    const { location } = await call({ code: "auth-code", state: stale });
    expect(location).toContain("gmail=error");
    expect(location).toContain("OAuth flow expired");
    expect(getTokenSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("a state just inside the 10-minute window still connects", async () => {
    const fresh = encodeState({ userId: "victim-user", nonce: "n", ts: Date.now() - 9 * 60 * 1000 });
    const { location } = await call({ code: "auth-code", state: fresh });
    expect(location).toContain("gmail=connected");
  });

  it("a valid state exchanges the code and persists tokens for the session user", async () => {
    const { location } = await call({ code: "auth-code", state: encodeState(VALID_STATE()) });
    expect(location).toContain("gmail=connected");
    expect(getTokenSpy).toHaveBeenCalledWith("auth-code");
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0][0].user_id).toBe("victim-user");
  });

  it("returnTo: a same-origin relative path is honored", async () => {
    const state = encodeState({ ...VALID_STATE(), returnTo: "/contacts?onboarding=1" });
    const { location } = await call({ code: "auth-code", state });
    expect(location).toBe("http://localhost:3000/contacts?onboarding=1");
  });

  it("returnTo: protocol-relative and absolute URLs fall back to /settings (open-redirect guard)", async () => {
    for (const returnTo of ["//evil.example", "https://evil.example/phish"]) {
      const state = encodeState({ ...VALID_STATE(), returnTo });
      const { location } = await call({ code: "auth-code", state });
      expect(location, `returnTo=${returnTo} must not escape the origin`).toBe(
        "http://localhost:3000/settings?gmail=connected",
      );
    }
  });
});
