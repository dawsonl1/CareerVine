import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-153/R2.5 + deep-review finding: the OAuth callback's send-as alias
 * capture must sit AFTER the token upsert (tokens are the point of the
 * callback; alias enrichment on the pre-persistence critical path risked the
 * function dying with a fresh refresh_token unstored), must be a single
 * fast-fail attempt, and must never wipe a previously stored alias set
 * (fetch failure or empty result -> no write; send-only grant -> no fetch).
 */

const callOrder: string[] = [];
const sendAsListSpy = vi.fn();
const upsertSpy = vi.fn();
const aliasUpdateSpy = vi.fn();

let grantedScope =
  "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify";

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } }, error: null }),
    },
  }),
}));

vi.mock("@/lib/oauth-helpers", () => ({
  getOAuth2Client: () => ({
    getToken: async () => ({
      tokens: {
        access_token: "at",
        refresh_token: "rt",
        id_token: "idt",
        scope: grantedScope,
        expiry_date: Date.now() + 3600_000,
      },
    }),
    setCredentials: () => {},
    verifyIdToken: async () => ({ getPayload: () => ({ email: "Me@Gmail.com" }) }),
  }),
  encryptOAuthToken: (v: string) => v,
  decryptOAuthToken: (v: string) => v,
}));

vi.mock("@googleapis/oauth2", () => ({
  oauth2: () => ({ userinfo: { get: async () => ({ data: { email: "me@gmail.com" } }) } }),
}));

vi.mock("@googleapis/gmail", () => ({
  gmail: () => ({
    users: {
      settings: {
        sendAs: {
          list: (...a: unknown[]) => {
            callOrder.push("sendAs.list");
            return sendAsListSpy(...a);
          },
        },
      },
    },
  }),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test chainable stub
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: (values: Record<string, unknown>) => {
          callOrder.push("upsert");
          upsertSpy(table, values);
          return Promise.resolve({ error: null });
        },
        update: (values: Record<string, unknown>) => {
          callOrder.push("update");
          aliasUpdateSpy(table, values);
          return builder;
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      };
      return builder;
    },
  }),
}));

import { GET } from "@/app/api/gmail/callback/route";

function makeReq() {
  const state = Buffer.from(JSON.stringify({ userId: "u-1", ts: Date.now() })).toString("base64url");
  const url = `http://localhost:3000/api/gmail/callback?code=auth-code&state=${state}`;
  return {
    method: "GET",
    url,
    nextUrl: new URL(url),
    headers: new Headers(),
    json: async () => ({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request stub
  } as any;
}

async function call() {
  const res = await GET(makeReq(), { params: Promise.resolve({}) });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

describe("gmail/callback — send-as alias capture (CAR-153/R2.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    grantedScope =
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify";
    sendAsListSpy.mockResolvedValue({
      data: { sendAs: [{ sendAsEmail: "Me@Gmail.com" }, { sendAsEmail: " Alias@X.dev " }] },
    });
  });

  it("persists tokens FIRST, then stores lowercased aliases via a follow-up update", async () => {
    const { location } = await call();

    expect(location).toContain("gmail=connected");
    // Ordering: the token upsert must precede the alias fetch — enrichment
    // never sits between token exchange and persistence.
    expect(callOrder.indexOf("upsert")).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf("sendAs.list")).toBeGreaterThan(callOrder.indexOf("upsert"));
    // The upsert itself carries no alias column; the follow-up update does.
    expect(upsertSpy.mock.calls[0][1]).not.toHaveProperty("send_as_aliases");
    const aliasWrite = aliasUpdateSpy.mock.calls.find(([t]) => t === "gmail_connections");
    expect(aliasWrite![1].send_as_aliases).toEqual(["me@gmail.com", "alias@x.dev"]);
  });

  it("a failed alias fetch never blocks the connect and writes nothing", async () => {
    sendAsListSpy.mockRejectedValue(Object.assign(new Error("boom"), { code: 500 }));

    const { location } = await call();

    expect(location).toContain("gmail=connected");
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(aliasUpdateSpy).not.toHaveBeenCalled();
    // Single fast-fail attempt: no retries on the user-facing redirect.
    expect(sendAsListSpy).toHaveBeenCalledTimes(1);
  });

  it("an empty alias result is skipped so a previously stored set is preserved", async () => {
    sendAsListSpy.mockResolvedValue({ data: { sendAs: [] } });

    const { location } = await call();

    expect(location).toContain("gmail=connected");
    expect(aliasUpdateSpy).not.toHaveBeenCalled();
  });

  it("a send-only grant never touches Gmail settings and preserves stored aliases", async () => {
    grantedScope =
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send";

    const { location } = await call();

    expect(location).toContain("gmail=connected");
    expect(sendAsListSpy).not.toHaveBeenCalled();
    expect(aliasUpdateSpy).not.toHaveBeenCalled();
    expect(upsertSpy.mock.calls[0][1]).not.toHaveProperty("send_as_aliases");
  });
});
