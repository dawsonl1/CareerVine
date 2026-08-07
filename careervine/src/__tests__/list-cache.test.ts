import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  readList,
  writeList,
  invalidateListsByPrefix,
  listKeysByPrefix,
  refreshList,
  inflightList,
  resetListCache,
  MIN_REFRESH_INTERVAL_MS,
} from "@/lib/list-cache";

/**
 * CAR-256. The cache is what makes back-navigation instant, so its two ways of
 * going stale — the TTL and an explicit invalidation — are the whole contract.
 * A cache that never expires shows contradicted rows; one that expires too
 * eagerly is just the refetch it replaced.
 */

beforeEach(resetListCache);

describe("list cache", () => {
  it("returns what was written, within the TTL", () => {
    writeList("k", [1, 2, 3], 1_000);
    expect(readList<number[]>("k", 5_000, 4_000)).toEqual([1, 2, 3]);
  });

  it("misses once the entry is older than the TTL", () => {
    writeList("k", [1], 1_000);
    // 5_001ms later against a 5_000ms window.
    expect(readList<number[]>("k", 5_000, 6_001)).toBeUndefined();
  });

  it("treats an entry exactly at the TTL as still fresh", () => {
    // The boundary is stated as `> ttl` rather than `>=`, and a test that only
    // checked "much older" would pass under either.
    writeList("k", [1], 1_000);
    expect(readList<number[]>("k", 5_000, 6_000)).toEqual([1]);
  });

  it("drops an expired entry rather than leaving it to pin memory", () => {
    writeList("k", [1], 1_000);
    readList("k", 5_000, 99_999);
    // A later read with a clock that would have been fresh finds nothing,
    // proving the miss deleted rather than merely skipped.
    expect(readList<number[]>("k", 5_000, 1_000)).toBeUndefined();
  });

  it("restamps age on rewrite", () => {
    writeList("k", [1], 1_000);
    writeList("k", [2], 10_000);
    expect(readList<number[]>("k", 5_000, 14_000)).toEqual([2]);
  });

  it("invalidates every key under a prefix, and nothing outside it", () => {
    writeList("companies:u-1:next", ["a"], 0);
    writeList("companies:u-1:name", ["b"], 0);
    writeList("companies:u-2:next", ["c"], 0);
    writeList("contacts:u-1:all", ["d"], 0);

    invalidateListsByPrefix("companies:u-1:");

    expect(readList("companies:u-1:next", 5_000, 0)).toBeUndefined();
    // The other sort matters: the user may have been on any of them when they
    // left, and one left holding contradicted rows is the bug this prevents.
    expect(readList("companies:u-1:name", 5_000, 0)).toBeUndefined();
    expect(readList("companies:u-2:next", 5_000, 0)).toEqual(["c"]);
    expect(readList("contacts:u-1:all", 5_000, 0)).toEqual(["d"]);
  });

  it("distinguishes a stored undefined-free miss from a stored empty list", () => {
    // An empty list is a real answer ("you have no companies") and must not read
    // back as a cache miss, or the page refetches on every return for exactly
    // the users with the least to show.
    writeList("k", [], 0);
    expect(readList<number[]>("k", 5_000, 0)).toEqual([]);
  });
});

/**
 * CAR-278. Deleting on a write left the cache cold at the exact moment the user
 * was most likely to press Back, so invalidation now refetches. The properties
 * that matter are the ones a naive "just call the fetcher" version gets wrong:
 * it must not fan out one aggregate per keystroke of an autosave, it must still
 * end up fetching the FINAL state rather than an intermediate one, and a result
 * that started before a write must never be written back as if it were current.
 */
describe("background refresh", () => {
  /** A fetcher whose settlement this test controls. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const TTL = 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetListCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("drops the entry immediately, before the refetch has anything to show", () => {
    writeList("k", ["old"]);
    refreshList("k", () => deferred<string[]>().promise);
    // The contract is NOT stale-while-revalidate: a read during the refetch is
    // an ordinary miss, so contradicted rows are never served.
    expect(readList("k", TTL)).toBeUndefined();
  });

  it("writes the fresh rows back, so the next read is a hit", async () => {
    refreshList("k", () => Promise.resolve(["new"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(readList<string[]>("k", TTL)).toEqual(["new"]);
  });

  it("collapses a burst into one fetch plus one trailing run", async () => {
    const calls: Array<ReturnType<typeof deferred<string[]>>> = [];
    const fetcher = () => {
      const d = deferred<string[]>();
      calls.push(d);
      return d.promise;
    };

    // Ten saves in quick succession, the shape `use-pipeline-autosave` produces.
    for (let i = 0; i < 10; i++) refreshList("k", fetcher);
    expect(calls).toHaveLength(1);

    calls[0].resolve(["intermediate"]);
    await vi.advanceTimersByTimeAsync(0);
    // That result STARTED before nine of the ten writes, so it is not the
    // current state and must not be cached as if it were.
    expect(readList("k", TTL)).toBeUndefined();

    // The trailing run is what makes the burst converge. Without it the cache
    // would stay empty until the TTL, i.e. exactly the old behaviour.
    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    calls[1].resolve(["final"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(readList<string[]>("k", TTL)).toEqual(["final"]);
  });

  it("runs the first request immediately, since one write then Back is the common case", () => {
    const fetcher = vi.fn(() => Promise.resolve(["a"]));
    refreshList("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("defers a request that arrives inside the interval, then runs it once", async () => {
    const fetcher = vi.fn(() => Promise.resolve(["a"]));
    refreshList("k", fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Settled, but still inside the window. A version that only de-duplicated
    // IN-FLIGHT fetches would fire again here, once per save, forever.
    await vi.advanceTimersByTimeAsync(1_000);
    refreshList("k", fetcher);
    refreshList("k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("leaves the key absent when the fetch rejects, and never rejects itself", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    writeList("k", ["old"]);
    expect(() => refreshList("k", () => Promise.reject(new Error("network")))).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(readList("k", TTL)).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it("does not write back a result whose key was dropped mid-flight", async () => {
    const d = deferred<string[]>();
    refreshList("k", () => d.promise);
    // Some other write clears the key while the fetch is out.
    invalidateListsByPrefix("k");
    d.resolve(["started-before-the-write"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(readList("k", TTL)).toBeUndefined();
  });

  describe("inflightList", () => {
    it("hands a reader the running fetch instead of a second copy", async () => {
      const d = deferred<string[]>();
      refreshList("k", () => d.promise);
      const joined = inflightList<string[]>("k");
      expect(joined).toBeDefined();
      d.resolve(["rows"]);
      await expect(joined).resolves.toEqual(["rows"]);
    });

    it("offers nothing once that fetch is known to predate a write", () => {
      refreshList("k", () => deferred<string[]>().promise);
      invalidateListsByPrefix("k");
      // Joining here would show the user rows their own action contradicted.
      expect(inflightList("k")).toBeUndefined();
    });

    it("offers nothing when no refresh is running", async () => {
      refreshList("k", () => Promise.resolve(["a"]));
      await vi.advanceTimersByTimeAsync(0);
      expect(inflightList("k")).toBeUndefined();
    });
  });

  it("reports a key that is only being refreshed, not just one holding a value", () => {
    refreshList("companies:u-1:next", () => deferred<string[]>().promise);
    // The entry is gone at this point. A `listKeysByPrefix` that read only the
    // value map would skip this key for the whole burst, so its in-flight fetch
    // would never be marked stale and would land as if current.
    expect(readList("companies:u-1:next", TTL)).toBeUndefined();
    expect(listKeysByPrefix("companies:u-1:")).toEqual(["companies:u-1:next"]);
    expect(listKeysByPrefix("companies:u-2:")).toEqual([]);
  });

  it("cancels a pending trailing run on reset, so a suite cannot leak one", async () => {
    const fetcher = vi.fn(() => Promise.resolve(["a"]));
    refreshList("k", fetcher);
    await vi.advanceTimersByTimeAsync(0);
    refreshList("k", fetcher); // inside the interval → scheduled
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    resetListCache();
    await vi.advanceTimersByTimeAsync(MIN_REFRESH_INTERVAL_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
