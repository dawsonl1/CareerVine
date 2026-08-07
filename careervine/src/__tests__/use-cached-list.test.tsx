// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useCachedList } from "@/hooks/use-cached-list";
import { resetListCache, writeList, readList, refreshList } from "@/lib/list-cache";

/**
 * CAR-256. The page-level test (`companies-page-cache.test.tsx`) proves the
 * feature; this one proves the primitive, including the paths a page cannot
 * reach — a null key while auth resolves, a forced reload, and a read that
 * throws. Those are the branches that decide whether the next page to adopt
 * this hook inherits working behavior or a latent bug.
 */

const TTL = 60_000;
const FALLBACK: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Every case below passes a `vi.fn()` created outside the render, so the
 * reference is already stable. The hook does not require that — it holds the
 * fetcher in a ref, which the last test in this file is what proves.
 */
function useHarness(key: string | null, fetcher: () => Promise<string[]>) {
  return useCachedList<string[]>({ key, ttlMs: TTL, fetcher, fallback: FALLBACK });
}

beforeEach(resetListCache);
afterEach(cleanup);

describe("useCachedList", () => {
  it("fetches on a cold key and writes the result to the cache", async () => {
    const fetcher = vi.fn(async () => ["a"]);
    const { result } = renderHook(() => useHarness("k", fetcher));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(["a"]);
    expect(result.current.fromCache).toBe(false);
    expect(readList<string[]>("k", TTL)).toEqual(["a"]);
  });

  it("serves a warm key without calling the fetcher at all", async () => {
    writeList("k", ["cached"]);
    const fetcher = vi.fn(async () => ["fresh"]);
    const { result } = renderHook(() => useHarness("k", fetcher));

    // No waitFor: a cache hit must be resolved on the first commit, because
    // that is what scroll restoration depends on.
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual(["cached"]);
    expect(result.current.fromCache).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stays loading and reads nothing while the key is null", () => {
    // The whole window in which AuthProvider has not resolved a user yet.
    writeList("k", ["cached"]);
    const fetcher = vi.fn(async () => ["fresh"]);
    const { result } = renderHook(() => useHarness(null, fetcher));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual([]);
    expect(result.current.fromCache).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("picks the cache up when a null key becomes real", async () => {
    writeList("k", ["cached"]);
    const fetcher = vi.fn(async () => ["fresh"]);
    const { result, rerender } = renderHook(({ k }: { k: string | null }) => useHarness(k, fetcher), {
      initialProps: { k: null as string | null },
    });
    expect(result.current.loading).toBe(true);

    rerender({ k: "k" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(["cached"]);
    expect(result.current.fromCache).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refetches when the key changes, because the key encodes the query", async () => {
    const fetcher = vi.fn(async () => ["a"]);
    const { result, rerender } = renderHook(({ k }: { k: string }) => useHarness(k, fetcher), {
      initialProps: { k: "sort-next" },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ k: "sort-name" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("keeps the last good data on a failure, and flags it", async () => {
    // The load-vs-resync split: `data` is never cleared, so the page can show a
    // banner over a still-valid list rather than the load-empty copy.
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["a"])
      .mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useHarness("k", fetcher));
    await waitFor(() => expect(result.current.data).toEqual(["a"]));

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.data).toEqual(["a"]);
    expect(result.current.loading).toBe(false);
  });

  it("does not cache a failure", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useHarness("k", fetcher));
    await waitFor(() => expect(result.current.failed).toBe(true));
    // A cached failure would strand the page on its error state for the whole
    // TTL with no way out but a hard refresh.
    expect(readList("k", TTL)).toBeUndefined();
  });

  it("reload() bypasses a warm cache", async () => {
    writeList("k", ["stale"]);
    const fetcher = vi.fn(async () => ["fresh"]);
    const { result } = renderHook(() => useHarness("k", fetcher));
    expect(fetcher).not.toHaveBeenCalled();

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toEqual(["fresh"]));
    expect(result.current.fromCache).toBe(false);
    expect(readList<string[]>("k", TTL)).toEqual(["fresh"]);
  });

  it("commits only the newest read when two overlap", async () => {
    // Two reads genuinely race: the sort control stays enabled while one is in
    // flight. Ungated, the slower FIRST read lands last and wins.
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = renderHook(({ k }: { k: string }) => useHarness(k, fetcher), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(["newer"]);
      first.resolve(["older"]);
      await Promise.resolve();
    });

    expect(result.current.data).toEqual(["newer"]);
  });

  it("does not surface a stale REJECTION over a newer success", async () => {
    // The CAR-205 shape: an ungated late rejection sets `failed` with nothing
    // left to clear it, so the page shows an error over a correct list.
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const fetcher = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, rerender } = renderHook(({ k }: { k: string }) => useHarness(k, fetcher), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(["newer"]);
      first.reject(new Error("stale boom"));
      await Promise.resolve();
    });

    expect(result.current.failed).toBe(false);
    expect(result.current.data).toEqual(["newer"]);
  });

  it("survives an un-memoized fetcher without looping", async () => {
    // The trap this hook's ref exists to close: a caller who passes a fresh
    // function every render would otherwise get a new `run` every render.
    let calls = 0;
    const { result, rerender } = renderHook(() =>
      useCachedList<string[]>({
        key: "k",
        ttlMs: TTL,
        fetcher: async () => {
          calls += 1;
          return ["a"];
        },
        fallback: FALLBACK,
      }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();
    rerender();
    expect(calls).toBe(1);
  });

  /**
   * CAR-278. A write on a detail page starts a background refresh of this exact
   * key, and pressing Back lands here while it is still running. Issuing a
   * second copy of the same query would double a multi-second aggregate for no
   * new information.
   */
  describe("joining a background refresh", () => {
    it("awaits the refresh in flight instead of fetching again", async () => {
      const refresh = deferred<string[]>();
      const own = vi.fn(() => Promise.resolve(["own"]));
      refreshList("k", () => refresh.promise);

      const { result } = renderHook(() => useHarness("k", own));
      expect(result.current.loading).toBe(true);
      expect(own).not.toHaveBeenCalled();

      await act(async () => {
        refresh.resolve(["refreshed"]);
        await refresh.promise;
      });

      expect(result.current.data).toEqual(["refreshed"]);
      // Still zero: the whole point is that no second query was issued.
      expect(own).not.toHaveBeenCalled();
      // `fromCache` stays false — the user did wait, so scroll restoration
      // correctly declines to jump them down the page.
      expect(result.current.fromCache).toBe(false);
    });

    it("fetches for itself when the refresh in flight is already out of date", async () => {
      const refresh = deferred<string[]>();
      const own = vi.fn(() => Promise.resolve(["own"]));
      refreshList("k", () => refresh.promise);
      // A second write lands: that fetch started before it, so its rows are
      // known-stale and joining would show the user contradicted data.
      refreshList("k", () => refresh.promise);

      const { result } = renderHook(() => useHarness("k", own));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(own).toHaveBeenCalledTimes(1);
      expect(result.current.data).toEqual(["own"]);
    });

    it("reload() ignores an in-flight refresh, because Retry means fetch now", async () => {
      const refresh = deferred<string[]>();
      const own = vi.fn(() => Promise.resolve(["own"]));
      refreshList("k", () => refresh.promise);

      const { result } = renderHook(() => useHarness("k", own));
      act(() => result.current.reload());
      await waitFor(() => expect(result.current.data).toEqual(["own"]));
      expect(own).toHaveBeenCalledTimes(1);
    });

    it("surfaces a joined rejection as a failed read", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const refresh = deferred<string[]>();
      const own = vi.fn(() => Promise.resolve(["own"]));
      refreshList("k", () => refresh.promise);

      const { result } = renderHook(() => useHarness("k", own));
      await act(async () => {
        refresh.reject(new Error("network"));
        await refresh.promise.catch(() => {});
      });

      expect(result.current.failed).toBe(true);
      expect(result.current.loading).toBe(false);
      spy.mockRestore();
    });
  });
});
