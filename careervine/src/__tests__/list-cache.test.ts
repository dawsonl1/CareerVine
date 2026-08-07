import { describe, it, expect, beforeEach } from "vitest";
import {
  readList,
  writeList,
  invalidateListsByPrefix,
  resetListCache,
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
