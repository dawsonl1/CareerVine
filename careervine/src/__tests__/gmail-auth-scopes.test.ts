import { describe, it, expect, vi } from "vitest";

/**
 * CAR-102: the default consent URL must be SENSITIVE-ONLY (sign-in + gmail.send,
 * no restricted gmail.modify) so free OAuth verification needs no CASA. gmail.modify
 * is added only for a premium connect/reconnect (includeModify).
 */

vi.mock("@/lib/oauth-helpers", () => ({
  // generateAuthUrl echoes the requested scopes so we can assert on them.
  getOAuth2Client: () => ({ generateAuthUrl: (o: { scope: string[] }) => o.scope.join(" ") }),
  refreshTokenIfNeeded: async () => {},
  decryptOAuthToken: (v: string) => v,
  encryptOAuthToken: (v: string) => v,
}));

vi.mock("googleapis", () => ({
  google: { gmail: () => ({}), auth: { OAuth2: class {} }, oauth2: () => ({}) },
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({}),
}));

import { getAuthUrl } from "@/lib/gmail";

describe("getAuthUrl scope sets (CAR-102)", () => {
  it("default (new/free connect) requests sign-in + gmail.send, NOT gmail.modify or calendar", () => {
    const scope = getAuthUrl("state");
    expect(scope).toContain("openid");
    expect(scope).toContain("userinfo.email");
    expect(scope).toContain("gmail.send");
    expect(scope).not.toContain("gmail.modify");
    expect(scope).not.toContain("calendar");
  });

  it("includeCalendar adds least-privilege calendar scopes (readonly + events), NOT full calendar or gmail.modify (CAR-111)", () => {
    const scopes = getAuthUrl("state", { includeCalendar: true }).split(" ");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.readonly");
    expect(scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    // The broad full-access `calendar` scope must NOT be requested (exact-match on
    // the split array — `.../calendar` !== `.../calendar.readonly`).
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/gmail.modify");
  });

  it("includeModify (premium reconnect) adds gmail.modify alongside send", () => {
    const scope = getAuthUrl("state", { includeModify: true });
    expect(scope).toContain("gmail.modify");
    expect(scope).toContain("gmail.send");
  });
});
