/**
 * The src/lib/data client seam (CAR-146): db() resolves lazily to the
 * browser singleton, setDataClient() injects a replacement (server/MCP/
 * tests), and must() enforces the throw-on-error read convention.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { PostgrestError, PostgrestSingleResponse } from "@supabase/supabase-js";

const h = vi.hoisted(() => {
  const browserClient = { kind: "browser" };
  return {
    browserClient,
    createSupabaseBrowserClient: vi.fn(() => browserClient),
  };
});

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: h.createSupabaseBrowserClient,
}));

import { db, setDataClient, must, type QueryClient } from "@/lib/data/client";

afterEach(() => {
  setDataClient(null);
});

describe("db()", () => {
  it("lazily creates the browser client once and caches it", () => {
    expect(h.createSupabaseBrowserClient).not.toHaveBeenCalled();
    const first = db();
    const second = db();
    expect(first).toBe(h.browserClient);
    expect(second).toBe(h.browserClient);
    expect(h.createSupabaseBrowserClient).toHaveBeenCalledTimes(1);
  });

  it("routes through an injected client without touching the browser factory", () => {
    const injected = { kind: "injected" } as unknown as QueryClient;
    const factoryCallsBefore = h.createSupabaseBrowserClient.mock.calls.length;

    setDataClient(injected);
    expect(db()).toBe(injected);
    expect(h.createSupabaseBrowserClient).toHaveBeenCalledTimes(factoryCallsBefore);
  });

  it("restores the browser fallback after setDataClient(null)", () => {
    setDataClient({ kind: "injected" } as unknown as QueryClient);
    setDataClient(null);
    expect(db()).toBe(h.browserClient);
  });
});

describe("must()", () => {
  const pgError = { message: "boom", details: "", hint: "", code: "XX000" } as PostgrestError;
  const ok = <T,>(data: T): PostgrestSingleResponse<T> =>
    ({ data, error: null, count: null, status: 200, statusText: "OK" });
  const failed: PostgrestSingleResponse<never> =
    { data: null, error: pgError, count: null, status: 400, statusText: "Bad Request" };

  it("returns data when the response succeeded", () => {
    expect(must(ok([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("preserves a maybeSingle miss (null data, no error)", () => {
    expect(must(ok<{ id: number } | null>(null))).toBeNull();
  });

  it("throws the PostgrestError itself on failure", () => {
    let thrown: unknown = null;
    try {
      must(failed);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(pgError);
  });
});
