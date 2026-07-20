/**
 * CAR-158 (F54): the Google API error accessors.
 *
 * These replaced `catch (err: any)` blocks in lib/calendar.ts, lib/gmail.ts and
 * lib/oauth-helpers.ts, each of which branched on a detail buried in a gaxios
 * rejection. The cases below pin the behaviours those call sites depend on —
 * especially that a transport failure never reads as an HTTP status, which is
 * what keeps "ENOTFOUND" from being retried as a 5xx or mistaken for a 410.
 */

import { describe, it, expect } from "vitest";
import {
  isGoogleApiError,
  googleApiStatus,
  googleApiReason,
  googleOAuthErrorCode,
} from "@/lib/google-api-error";

/** Build an Error with extra gaxios-ish fields attached. */
function apiError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("boom"), fields);
}

describe("isGoogleApiError", () => {
  it("accepts an Error carrying any recognised field", () => {
    expect(isGoogleApiError(apiError({ code: 410 }))).toBe(true);
    expect(isGoogleApiError(apiError({ status: 401 }))).toBe(true);
    expect(isGoogleApiError(apiError({ response: {} }))).toBe(true);
    expect(isGoogleApiError(apiError({ errors: [] }))).toBe(true);
  });

  it("rejects a plain Error and non-Error values", () => {
    expect(isGoogleApiError(new Error("plain"))).toBe(false);
    expect(isGoogleApiError({ code: 410 })).toBe(false);
    expect(isGoogleApiError(null)).toBe(false);
    expect(isGoogleApiError(undefined)).toBe(false);
    expect(isGoogleApiError("410")).toBe(false);
  });
});

describe("googleApiStatus", () => {
  it("reads status, code, and response.status in that order", () => {
    expect(googleApiStatus(apiError({ status: 403 }))).toBe(403);
    expect(googleApiStatus(apiError({ code: 410 }))).toBe(410);
    expect(googleApiStatus(apiError({ response: { status: 429 } }))).toBe(429);
  });

  it("prefers status over code when both are present", () => {
    expect(googleApiStatus(apiError({ status: 401, code: 500 }))).toBe(401);
  });

  it("parses a numeric string code", () => {
    expect(googleApiStatus(apiError({ code: "404" }))).toBe(404);
  });

  it("never treats a transport error code as an HTTP status", () => {
    // The regression this guards: lib/gmail.ts retries on 429 and 5xx, and
    // lib/calendar.ts throws SYNC_TOKEN_EXPIRED on 410. If "ENOTFOUND" or
    // "ECONNRESET" leaked through as a status, a DNS blip would either be
    // retried as a server error or wipe a valid sync token.
    expect(googleApiStatus(apiError({ code: "ENOTFOUND" }))).toBeUndefined();
    expect(googleApiStatus(apiError({ code: "ECONNRESET" }))).toBeUndefined();
  });

  it("returns undefined when there is no status anywhere", () => {
    expect(googleApiStatus(new Error("plain"))).toBeUndefined();
    expect(googleApiStatus(apiError({ response: {} }))).toBeUndefined();
    expect(googleApiStatus(null)).toBeUndefined();
    expect(googleApiStatus({ status: 500 })).toBe(500);
  });
});

describe("googleApiReason", () => {
  it("reads a top-level errors[0].reason", () => {
    expect(googleApiReason(apiError({ errors: [{ reason: "rateLimitExceeded" }] }))).toBe(
      "rateLimitExceeded",
    );
  });

  it("reads the nested response.data.error.errors[0].reason", () => {
    const err = apiError({
      response: { data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } },
    });
    expect(googleApiReason(err)).toBe("userRateLimitExceeded");
  });

  it("prefers the top-level reason when both are present", () => {
    const err = apiError({
      errors: [{ reason: "top" }],
      response: { data: { error: { errors: [{ reason: "nested" }] } } },
    });
    expect(googleApiReason(err)).toBe("top");
  });

  it("returns undefined for missing, empty, or malformed shapes", () => {
    expect(googleApiReason(new Error("plain"))).toBeUndefined();
    expect(googleApiReason(apiError({ errors: [] }))).toBeUndefined();
    expect(googleApiReason(apiError({ errors: "not-an-array" }))).toBeUndefined();
    expect(googleApiReason(apiError({ errors: [{}] }))).toBeUndefined();
    expect(googleApiReason(apiError({ response: { data: { error: "invalid_grant" } } }))).toBeUndefined();
  });
});

describe("googleOAuthErrorCode", () => {
  it("reads the string error out of the response body", () => {
    const err = apiError({ response: { data: { error: "invalid_grant" } } });
    expect(googleOAuthErrorCode(err)).toBe("invalid_grant");
  });

  it("returns undefined when error is an object rather than a string", () => {
    // The same field holds an object on API (non-OAuth) failures; reading it as
    // a code there would make lib/oauth-helpers delete a live connection.
    const err = apiError({ response: { data: { error: { errors: [{ reason: "x" }] } } } });
    expect(googleOAuthErrorCode(err)).toBeUndefined();
  });

  it("returns undefined for missing shapes", () => {
    expect(googleOAuthErrorCode(new Error("plain"))).toBeUndefined();
    expect(googleOAuthErrorCode(apiError({ response: {} }))).toBeUndefined();
    expect(googleOAuthErrorCode(null)).toBeUndefined();
  });
});
