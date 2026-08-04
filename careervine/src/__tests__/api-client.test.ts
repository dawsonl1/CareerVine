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

/**
 * The init the client actually handed fetch, with `headers` flattened to a
 * plain object.
 *
 * CAR-215 made every request carry an X-CV-Timezone header, so `headers` is now
 * always a Headers instance rather than the caller's literal. Asserting on a
 * deep-equal init would mean restating that header in a dozen unrelated cases
 * and would break again on the next transport-level addition, so the header set
 * is asserted where it is the subject and read structurally everywhere else.
 */
function callInit(fn: ReturnType<typeof mockFetch>): {
  init: RequestInit;
  headers: Record<string, string>;
} {
  const init = fn.mock.calls[0][1] as RequestInit;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  return { init, headers };
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
    expect(fn).toHaveBeenCalledWith("/api/x", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("lets an explicit init override the defaults", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiFetch("/api/x", jsonBody({ a: 1 }));
    const { init, headers } = callInit(fn);
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
    // The caller's own header survives the timezone merge.
    expect(headers["content-type"]).toBe("application/json");
  });

  /**
   * CAR-215: the server has no other way to learn a user's zone. Before this,
   * the only stored value was gmail_connections.calendar_timezone, which
   * defaulted to America/New_York, so three of eight recorded "Eastern" users
   * had never been near Eastern time.
   */
  it("attaches the browser's IANA timezone to every request", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiFetch("/api/x");
    const { headers } = callInit(fn);
    const sent = headers["x-cv-timezone"];
    expect(sent).toBeTruthy();
    // Must be a zone Intl can resolve, since the server feeds it straight to Intl.
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: sent })).not.toThrow();
    expect(sent).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("attaches it on apiSend as well, not just apiFetch", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiSend("/api/x", jsonBody({ a: 1 }));
    expect(callInit(fn).headers["x-cv-timezone"]).toBeTruthy();
  });

  it("does not overwrite a timezone the caller set deliberately", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiFetch("/api/x", { headers: { "X-CV-Timezone": "Asia/Tokyo" } });
    expect(callInit(fn).headers["x-cv-timezone"]).toBe("Asia/Tokyo");
  });

  it("still sends the request when the environment has no resolvable zone", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    const real = Intl.DateTimeFormat;
    // A thrown Intl must not take the request down with it.
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: function () {
        throw new Error("no ICU");
      },
    });
    try {
      await expect(apiFetch("/api/x")).resolves.toEqual({});
      expect(callInit(fn).headers["x-cv-timezone"]).toBeUndefined();
    } finally {
      vi.stubGlobal("Intl", { ...Intl, DateTimeFormat: real });
    }
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
});

/**
 * `jsonBody(value, method = "POST")` — the second argument, asserted on the wire
 * (CAR-204).
 *
 * Ten production call sites depend on it, all converted from an explicit
 * `method:` on a raw fetch, several of them by an automated pattern
 * replacement. A regression to the POST default would still compile, still pass
 * every other test, and silently send a PATCH as a POST to routes that only
 * export the one handler — so the request would 405 or, worse, hit a different
 * handler on the same path. Nothing covered this before: the existing DELETE
 * case above asserts only that the promise resolves.
 */
describe("jsonBody verb", () => {
  it("defaults to POST", () => {
    expect(jsonBody({ a: 1 })).toEqual({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
  });

  it.each(["PATCH", "PUT", "DELETE"] as const)("carries %s through to fetch", async (method) => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiFetch("/api/x", jsonBody({ a: 1 }, method));
    const { init, headers } = callInit(fn);
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe(method);
    expect(init.body).toBe('{"a":1}');
    expect(headers["content-type"]).toBe("application/json");
  });

  it("carries the verb through apiSend too", async () => {
    const fn = mockFetch({ ok: true, status: 200, json: async () => ({}) });
    await apiSend("/api/x", jsonBody({ b: 2 }, "PATCH"));
    const { init, headers } = callInit(fn);
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"b":2}');
    expect(headers["content-type"]).toBe("application/json");
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
