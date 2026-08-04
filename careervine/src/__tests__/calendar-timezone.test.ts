/**
 * CAR-220: `getCalendarTimezone` must be able to say "I don't know".
 *
 * CAR-215 set out to purge a fake America/New_York that had been written for
 * users who never completed a calendar sync, and "fixed" the write site with
 * `calendar_timezone: tz || null`. That branch was unreachable — this function
 * returned DEFAULT_TIMEZONE from BOTH its fallbacks, so `tz` was never falsy.
 *
 * The sibling route test cannot catch that, because it mocks this function
 * wholesale and therefore never executes it. Deliberately noted here: a route
 * test asserting "given null, stores null" looks like coverage of the fix and
 * is not. This file is the one that fails if the fallbacks regress.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockServiceClientModule } from "./helpers/mock-supabase";

const settingsGet = vi.fn();

// Typed factory rather than a hand-rolled object literal: a hand-rolled one is
// not checked against the module it replaces and keeps compiling after the real
// export changes (CAR-187).
vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({
            data: {
              access_token: "enc-access",
              refresh_token: "enc-refresh",
              token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              calendar_scopes_granted: true,
            },
            error: null,
          }),
        }),
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  })),
);

vi.mock("@/lib/crypto", () => ({
  decryptOAuthToken: (v: string) => v,
  encryptOAuthToken: (v: string) => v,
}));

vi.mock("@/lib/google-oauth", () => ({
  getOAuth2Client: () => ({
    setCredentials: () => {},
    on: () => {},
    credentials: {},
  }),
}));

vi.mock("@googleapis/calendar", () => ({
  calendar: () => ({ settings: { get: (...a: unknown[]) => settingsGet(...a) } }),
  auth: { OAuth2: class {} },
}));

import { getCalendarTimezone, DEFAULT_TIMEZONE } from "@/lib/calendar";

beforeEach(() => {
  settingsGet.mockReset();
});

describe("getCalendarTimezone", () => {
  it("returns the zone Google reports", async () => {
    settingsGet.mockResolvedValue({ data: { value: "America/Denver" } });
    await expect(getCalendarTimezone("u1")).resolves.toBe("America/Denver");
  });

  it("returns null when the settings call throws, never a regional guess", async () => {
    settingsGet.mockRejectedValue(new Error("transient Google failure"));
    const zone = await getCalendarTimezone("u1");
    expect(zone).toBeNull();
    expect(zone).not.toBe(DEFAULT_TIMEZONE);
  });

  it("returns null when Google reports an empty value", async () => {
    settingsGet.mockResolvedValue({ data: { value: "" } });
    await expect(getCalendarTimezone("u1")).resolves.toBeNull();
  });

  it("returns null when the response has no value at all", async () => {
    settingsGet.mockResolvedValue({ data: {} });
    await expect(getCalendarTimezone("u1")).resolves.toBeNull();
  });
});
