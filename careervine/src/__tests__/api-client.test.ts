/**
 * CAR-158 (F24): the typed API client seam.
 *
 * The behaviour that matters is the non-2xx path. A client that returned the
 * parsed body on an error status would hand callers an ApiErrorBody typed as
 * the success shape, which is the exact failure this seam exists to prevent.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  apiFetch,
  apiSend,
  jsonBody,
  isApiRequestError,
  ApiRequestError,
} from "@/lib/api-client";

function mockFetch(res: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fn = vi.fn().mockResolvedValue(res);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("returns the parsed body on success", async () => {
    mockFetch({ ok: true, status: 200, json: async () => ({ count: 3 }) });
    await expect(apiFetch<{ count: number }>("/api/x")).resolves.toEqual({ count: 3 });
  });

  it("sends same-origin credentials by default so the auth cookie rides along", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiFetch("/api/x");
    expect(fn).toHaveBeenCalledWith("/api/x", { credentials: "same-origin" });
  });

  it("lets an explicit init override the defaults", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiFetch("/api/x", jsonBody({ a: 1 }));
    expect(fn).toHaveBeenCalledWith("/api/x", {
      credentials: "same-origin",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("throws the route's curated message on a non-2xx, never returning the error body", async () => {
    mockFetch({
      ok: false,
      status: 429,
      json: async () => ({ error: "Synced recently, try again later.", code: "rate_limited" }),
    });
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      name: "ApiRequestError",
      message: "Synced recently, try again later.",
      status: 429,
      code: "rate_limited",
    });
  });

  it("exposes the parsed error body for callers that need more than the message", async () => {
    mockFetch({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden", capability: "ai_access" }),
    });
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      body: { error: "Forbidden", capability: "ai_access" },
    });
  });

  it("falls back to generic copy when the error body is unparseable", async () => {
    // An edge/proxy HTML error page, not our route: the user must not see a
    // JSON parser error.
    mockFetch({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      message: "Something went wrong. Please try again.",
      status: 502,
    });
  });

  it("falls back when the error body carries a blank message", async () => {
    mockFetch({ ok: false, status: 500, json: async () => ({ error: "   " }) });
    await expect(apiFetch("/api/x")).rejects.toMatchObject({
      message: "Something went wrong. Please try again.",
    });
  });

  it("wraps an unreadable 2xx body as ApiRequestError, never a bare SyntaxError", async () => {
    // A 204, or an edge response that never reached the route. Callers catch
    // ApiRequestError; a raw SyntaxError would slip straight past them.
    mockFetch({
      ok: true,
      status: 204,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    });
    const err = await apiFetch("/api/x").catch((e: unknown) => e);
    expect(isApiRequestError(err)).toBe(true);
    expect(err).toMatchObject({ status: 204, code: "unreadable_response" });
  });
});

describe("apiSend", () => {
  it("resolves without parsing the body on success", async () => {
    const json = vi.fn();
    mockFetch({ ok: true, status: 204, json });
    await expect(apiSend("/api/x", jsonBody({}, "DELETE"))).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it("throws the curated message on a non-2xx", async () => {
    mockFetch({ ok: false, status: 400, json: async () => ({ error: "Bad request" }) });
    await expect(apiSend("/api/x")).rejects.toMatchObject({
      message: "Bad request",
      status: 400,
    });
  });
});

describe("isApiRequestError", () => {
  it("distinguishes an ApiRequestError from other failures", () => {
    expect(isApiRequestError(new ApiRequestError("x", 400))).toBe(true);
    expect(isApiRequestError(new Error("network down"))).toBe(false);
    expect(isApiRequestError(null)).toBe(false);
  });
});
