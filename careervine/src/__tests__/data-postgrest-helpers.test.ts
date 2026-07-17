/**
 * Shared PostgREST scale utilities (CAR-146, findings F53/F29).
 *
 * escapeIlike absorbs the former search-helpers.test.ts coverage (the
 * duplicate escapeIlikePattern died with its file). chunked/paginateAll
 * carry the >1000-row correctness proof the exit criteria require.
 */

import { describe, it, expect, vi } from "vitest";
import { escapeIlike, chunkList, chunked, paginateAll } from "@/lib/data/postgrest";

describe("escapeIlike", () => {
  it("escapes percent signs", () => {
    expect(escapeIlike("100%")).toBe("100\\%");
  });

  it("escapes underscores", () => {
    expect(escapeIlike("john_doe")).toBe("john\\_doe");
  });

  it("escapes backslashes", () => {
    expect(escapeIlike("O\\Brien")).toBe("O\\\\Brien");
  });

  it("escapes multiple special characters", () => {
    expect(escapeIlike("%_test\\val_")).toBe("\\%\\_test\\\\val\\_");
  });

  it("leaves normal text unchanged", () => {
    expect(escapeIlike("John Smith")).toBe("John Smith");
  });

  it("handles empty string", () => {
    expect(escapeIlike("")).toBe("");
  });

  it("does not escape dots (unlike sanitizeForPostgrest)", () => {
    expect(escapeIlike("J.R. Smith")).toBe("J.R. Smith");
  });

  it("does not escape parentheses", () => {
    expect(escapeIlike("John (Johnny)")).toBe("John (Johnny)");
  });

  it("prevents wildcard injection", () => {
    // An attacker trying to match everything
    const result = escapeIlike("%");
    expect(result).toBe("\\%");
    // When wrapped in %...%, this would become %\%% which matches literal %
  });
});

describe("chunkList", () => {
  it("returns no chunks for an empty list", () => {
    expect(chunkList([])).toEqual([]);
  });

  it("splits on the default size of 100", () => {
    const chunks = chunkList(Array.from({ length: 250 }, (_, i) => i));
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it("keeps an exact multiple free of a trailing empty chunk", () => {
    expect(chunkList([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it("preserves element order across chunks", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    expect(chunkList(items, 3).flat()).toEqual(items);
  });
});

describe("chunked", () => {
  it("passes every id exactly once, in ≤200-id chunks, beyond 1000 ids", async () => {
    const ids = Array.from({ length: 1050 }, (_, i) => i + 1);
    const seenChunks: number[][] = [];
    const rows = await chunked(ids, async (chunk) => {
      seenChunks.push(chunk);
      return chunk.map((id) => ({ id }));
    });

    expect(seenChunks.map((c) => c.length)).toEqual([200, 200, 200, 200, 200, 50]);
    expect(seenChunks.flat()).toEqual(ids);
    // All 1050 rows come back, concatenated in call order — nothing is
    // silently dropped past the PostgREST row cap.
    expect(rows).toHaveLength(1050);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it("never invokes the query for an empty id list", async () => {
    const fn = vi.fn(async () => []);
    expect(await chunked([], fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("propagates a chunk failure instead of returning partial rows", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => i);
    await expect(
      chunked(ids, async (chunk) => {
        if (chunk[0] === 200) throw new Error("boom");
        return chunk;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("paginateAll", () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: from + i }));

  it("walks contiguous windows until a short page and returns >1000 rows intact", async () => {
    const TOTAL = 2350;
    const windows: Array<[number, number]> = [];
    const rows = await paginateAll(async (from, to) => {
      windows.push([from, to]);
      return page(from, Math.max(0, Math.min(TOTAL - from, to - from + 1)));
    });

    expect(windows).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(rows).toHaveLength(TOTAL);
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[TOTAL - 1]).toEqual({ id: TOTAL - 1 });
  });

  it("fetches exactly one extra page when the total is a page multiple", async () => {
    const fetchPage = vi.fn(async (from: number) => (from < 2000 ? page(from, 1000) : []));
    const rows = await paginateAll(fetchPage);
    expect(rows).toHaveLength(2000);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("treats a null page as empty and terminates (chain-recorder test mocks resolve data: null)", async () => {
    const rows = await paginateAll(async () => null);
    expect(rows).toEqual([]);
  });

  it("respects a custom page size", async () => {
    const windows: Array<[number, number]> = [];
    await paginateAll(async (from, to) => {
      windows.push([from, to]);
      return from === 0 ? page(from, 50) : page(from, 10);
    }, 50);
    expect(windows).toEqual([
      [0, 49],
      [50, 99],
    ]);
  });

  it("propagates a page failure", async () => {
    await expect(
      paginateAll(async (from) => {
        if (from > 0) throw new Error("boom");
        return page(from, 1000);
      }),
    ).rejects.toThrow("boom");
  });
});
