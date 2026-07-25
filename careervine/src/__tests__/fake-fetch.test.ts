// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { installFakeFetch } from "./helpers/fake-fetch";
import { apiSend, apiFetch, isApiRequestError } from "@/lib/api-client";

/**
 * Self-test for the shared component-HTTP harness (CAR-183).
 *
 * The helper's whole value is a claim about its fixtures: that they are REAL
 * `Response` objects, so a component test asserting through `apiSend` exercises
 * the production error path rather than a hand-rolled stub. Nothing else in the
 * suite pins that claim — the component tests only observe a toast, which any
 * throw would satisfy — so without this file the helper could be "simplified"
 * back into an object literal and every test would stay green.
 *
 * The jsdom environment is required, not cosmetic: it is what makes Node's
 * undici `Response` the global these fixtures are built from.
 */

afterEach(() => vi.unstubAllGlobals());

describe("installFakeFetch — fixtures are real Responses", () => {
  it("answers with an actual Response carrying ok, status and a parsed body", async () => {
    installFakeFetch({ "GET /api/x": { status: 201, body: { hello: "world" } } });

    const res = await fetch("/api/x");

    expect(res instanceof Response).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ hello: "world" });
  });

  it("produces a non-ok Response whose status and body survive to apiSend", async () => {
    installFakeFetch({
      "DELETE /api/x/7": { status: 404, body: { error: "Sequence not found" } },
    });

    const err = await apiSend("/api/x/7", { method: "DELETE" }).catch((e: unknown) => e);

    // The point of the real Response: apiSend's toApiError reads res.status and
    // res.json() off it, so the curated server message reaches the client.
    expect(isApiRequestError(err)).toBe(true);
    expect(err).toMatchObject({ status: 404, message: "Sequence not found" });
  });

  it("falls back to generic copy when the error body is not JSON", async () => {
    // An omitted body yields a null-bodied Response, so res.json() rejects and
    // apiSend must not leak a SyntaxError to the caller.
    installFakeFetch({ "DELETE /api/x/7": { status: 502 } });

    const err = await apiSend("/api/x/7", { method: "DELETE" }).catch((e: unknown) => e);

    expect(isApiRequestError(err)).toBe(true);
    expect(err).toMatchObject({ status: 502, message: "Something went wrong. Please try again." });
  });

  it("omits the body on a 204 rather than serializing undefined", async () => {
    installFakeFetch({ "DELETE /api/x/7": { status: 204 } });

    const res = await fetch("/api/x/7", { method: "DELETE" });

    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe("");
  });

  it("rejects when the route declares a network failure", async () => {
    installFakeFetch({ "GET /api/x": { reject: new TypeError("Failed to fetch") } });

    await expect(fetch("/api/x")).rejects.toThrow("Failed to fetch");
  });
});

describe("installFakeFetch — routing and recording", () => {
  it("throws and records the miss when no route matches", async () => {
    const http = installFakeFetch({ "GET /api/known": { body: {} } });

    await expect(fetch("/api/unknown")).rejects.toThrow(/no route for "GET \/api\/unknown"/);
    expect(http.unmatched).toEqual(["GET /api/unknown"]);
  });

  it("keys on method as well as path, and uppercases a lowercase method", async () => {
    const http = installFakeFetch({ "DELETE /api/x": { body: {} } });

    await fetch("/api/x", { method: "delete" });

    expect(http.calls).toEqual(["DELETE /api/x"]);
    expect(http.unmatched).toEqual([]);
  });

  it("keeps the query string in the key so two queries are distinguishable", async () => {
    const http = installFakeFetch({
      "GET /api/x?id=1": { body: { id: 1 } },
      "GET /api/x?id=2": { body: { id: 2 } },
    });

    await expect(apiFetch("/api/x?id=2")).resolves.toEqual({ id: 2 });
    expect(http.calls).toEqual(["GET /api/x?id=2"]);
  });

  it("normalizes absolute URL and Request inputs down to path and query", async () => {
    // Request.url and URL.toString() are always absolute, so without
    // normalization neither could ever match a "METHOD /path" route.
    const http = installFakeFetch({ "GET /api/x?a=1": { body: {} } });

    await fetch(new URL("http://localhost:3000/api/x?a=1"));
    await fetch(new Request("http://example.test/api/x?a=1"));

    expect(http.calls).toEqual(["GET /api/x?a=1", "GET /api/x?a=1"]);
    expect(http.unmatched).toEqual([]);
  });

  it("counts repeat calls and exposes the request payload", async () => {
    const http = installFakeFetch({ "POST /api/x": { body: { ok: true } } });

    await fetch("/api/x", { method: "POST", body: JSON.stringify({ name: "first" }) });
    await fetch("/api/x", { method: "POST", body: JSON.stringify({ name: "second" }) });

    expect(http.countOf("POST /api/x")).toBe(2);
    expect(http.countOf("GET /api/x")).toBe(0);
    // bodyOf returns the LAST matching request, so a retry is what gets asserted.
    expect(http.bodyOf("POST /api/x")).toEqual({ name: "second" });
    expect(http.requests[0]?.init?.method).toBe("POST");
  });

  it("returns undefined from bodyOf for a request that carried no body", async () => {
    const http = installFakeFetch({ "DELETE /api/x": { body: {} } });

    await fetch("/api/x", { method: "DELETE" });

    expect(http.bodyOf("DELETE /api/x")).toBeUndefined();
  });
});

describe("installFakeFetch — global hygiene", () => {
  it("restores the original fetch on unstubAllGlobals", () => {
    const original = globalThis.fetch;

    installFakeFetch({ "GET /api/x": { body: {} } });
    expect(globalThis.fetch).not.toBe(original);

    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(original);
  });
});
