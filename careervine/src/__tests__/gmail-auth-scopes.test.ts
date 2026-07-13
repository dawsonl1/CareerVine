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

import { getAuthUrl, deriveGrantedScopeFlags } from "@/lib/gmail";

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

describe("deriveGrantedScopeFlags — granular-consent handling (CAR-111)", () => {
  const READONLY = "https://www.googleapis.com/auth/calendar.readonly";
  const EVENTS = "https://www.googleapis.com/auth/calendar.events";
  const FULL = "https://www.googleapis.com/auth/calendar"; // legacy superset
  const SEND = "https://www.googleapis.com/auth/gmail.send";
  const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
  const MAIL = "https://mail.google.com/";

  it("full calendar consent (readonly + events) → calendarGranted true", () => {
    const f = deriveGrantedScopeFlags(`openid ${SEND} ${READONLY} ${EVENTS}`);
    expect(f).toEqual({ sendGranted: true, calendarGranted: true, modifyGranted: false });
  });

  it("partial calendar (readonly only, events unchecked) → calendarGranted FALSE", () => {
    const f = deriveGrantedScopeFlags(`${SEND} ${READONLY}`);
    expect(f.calendarGranted).toBe(false);
    expect(f.sendGranted).toBe(true);
  });

  it("partial calendar (events only, readonly unchecked) → calendarGranted FALSE", () => {
    const f = deriveGrantedScopeFlags(`${SEND} ${EVENTS}`);
    expect(f.calendarGranted).toBe(false);
  });

  it("legacy full `calendar` scope alone satisfies both read and write", () => {
    const f = deriveGrantedScopeFlags(`${SEND} ${FULL}`);
    expect(f.calendarGranted).toBe(true);
  });

  it("no calendar scopes → calendarGranted false, send still detected", () => {
    const f = deriveGrantedScopeFlags(`openid ${SEND}`);
    expect(f.calendarGranted).toBe(false);
    expect(f.sendGranted).toBe(true);
  });

  it("gmail.modify implies both sendGranted and modifyGranted", () => {
    const f = deriveGrantedScopeFlags(`${MODIFY} ${READONLY} ${EVENTS}`);
    expect(f.sendGranted).toBe(true);
    expect(f.modifyGranted).toBe(true);
  });

  it("legacy full-mail scope implies sendGranted", () => {
    expect(deriveGrantedScopeFlags(MAIL).sendGranted).toBe(true);
  });

  it("empty / undefined scope → all flags false", () => {
    const empty = { sendGranted: false, calendarGranted: false, modifyGranted: false };
    expect(deriveGrantedScopeFlags(undefined)).toEqual(empty);
    expect(deriveGrantedScopeFlags("")).toEqual(empty);
  });
});
