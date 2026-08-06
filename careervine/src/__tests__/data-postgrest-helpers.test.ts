/**
 * Shared PostgREST scale utilities (CAR-146, findings F53/F29).
 *
 * escapeIlike absorbs the former search-helpers.test.ts coverage (the
 * duplicate escapeIlikePattern died with its file). chunked/paginateAll
 * carry the >1000-row correctness proof the exit criteria require.
 */

import { describe, it, expect, vi } from "vitest";
import { escapeIlike, chunkList, chunked, chunkedPaginated, paginateAll } from "@/lib/data/postgrest";

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

describe("chunkedPaginated (CAR-223)", () => {
  /**
   * The gap this closes: chunked() bounds the .in() FILTER list but not the
   * RESPONSE, so on a table that fans out (several interactions or emails per
   * contact) a single 200-id chunk can itself pass PostgREST's 1000-row cap and
   * truncate in silence. chunkedPaginated bounds both.
   */
  it("pages WITHIN each chunk, so a fanned-out chunk is not silently truncated", async () => {
    const ROWS_PER_CHUNK = 2400;
    const seen: Array<{ chunkStart: number; from: number }> = [];
    const rows = await chunkedPaginated(
      Array.from({ length: 400 }, (_, i) => i),
      async (chunk, from, to) => {
        seen.push({ chunkStart: chunk[0], from });
        const remaining = Math.max(0, Math.min(ROWS_PER_CHUNK - from, to - from + 1));
        return Array.from({ length: remaining }, (_, i) => ({ chunk: chunk[0], id: from + i }));
      },
    );

    // 400 ids -> two 200-id chunks, each walked to exhaustion (3 pages: the
    // 2400th row means pages at 0, 1000, 2000 with the last one short).
    //
    // Asserted per chunk rather than as one flat sequence: chunks now run
    // concurrently (CAR-231), so the INTERLEAVING between them is not a contract
    // and pinning it would just re-break on the next scheduling change. What IS
    // still a contract is that each chunk walks its own pages in order, because a
    // short page is paginateAll's only stop signal.
    const pagesByChunk = new Map<number, number[]>();
    for (const { chunkStart, from } of seen) {
      pagesByChunk.set(chunkStart, [...(pagesByChunk.get(chunkStart) ?? []), from]);
    }
    expect([...pagesByChunk.keys()].sort((a, b) => a - b)).toEqual([0, 200]);
    expect(pagesByChunk.get(0)).toEqual([0, 1000, 2000]);
    expect(pagesByChunk.get(200)).toEqual([0, 1000, 2000]);
    // chunked() would have returned 2000 here (1000 per chunk), losing 2800 rows.
    expect(rows).toHaveLength(ROWS_PER_CHUNK * 2);
  });

  it("returns an empty array for no ids without issuing a query", async () => {
    const fetchPage = vi.fn(async () => []);
    expect(await chunkedPaginated([], fetchPage)).toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("honours custom chunk and page sizes", async () => {
    const seen: Array<[number, number, number, number]> = [];
    await chunkedPaginated(
      [1, 2, 3, 4],
      async (chunk, from, to) => {
        seen.push([chunk[0], chunk.length, from, to]);
        return from === 0 ? [{ id: 1 }, { id: 2 }] : [];
      },
      { chunkSize: 2, pageSize: 2 },
    );
    // Two chunks of 2, each paging 0-1 then 2-3. Grouped by chunk because the
    // interleaving between chunks is not a contract (CAR-231); the window sizes
    // and the per-chunk page progression are.
    const windowsFor = (first: number) =>
      seen.filter(([id]) => id === first).map(([, len, from, to]) => [len, from, to]);
    expect(windowsFor(1)).toEqual([
      [2, 0, 1],
      [2, 2, 3],
    ]);
    expect(windowsFor(3)).toEqual([
      [2, 0, 1],
      [2, 2, 3],
    ]);
  });

  it("carries string ids (linkedin urls, thread ids), not just numbers", async () => {
    const rows = await chunkedPaginated(["t1", "t2"], async (chunk) =>
      chunk.map((id) => ({ id })),
    );
    expect(rows).toEqual([{ id: "t1" }, { id: "t2" }]);
  });

  it("propagates a page failure instead of returning a short list", async () => {
    await expect(
      chunkedPaginated([1, 2, 3], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("bounded concurrency (CAR-231)", () => {
  /** ids spanning `n` chunks of 200. */
  const idsForChunks = (n: number) => Array.from({ length: n * 200 }, (_, i) => i + 1);

  it("runs chunks concurrently rather than one at a time", async () => {
    let peak = 0;
    let live = 0;
    await chunked(idsForChunks(6), async (chunk) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return chunk;
    });
    // The serial implementation this replaced never exceeded 1.
    expect(peak).toBeGreaterThan(1);
  });

  it("preserves INPUT order even when later chunks resolve first", async () => {
    // Staggered so chunk order and completion order are exactly reversed. A
    // push-on-complete implementation returns these reversed, and still passes every
    // length and set-membership check while silently reordering rows.
    const chunkCount = 4;
    const rows = await chunked(idsForChunks(chunkCount), async (chunk) => {
      const position = Math.floor((chunk[0] - 1) / 200);
      await new Promise((r) => setTimeout(r, (chunkCount - position) * 10));
      return [chunk[0]];
    });
    expect(rows).toEqual([1, 201, 401, 601]);
  });

  it("holds the ceiling ACROSS concurrent callers, not just within one", async () => {
    // The reason the gate is module-level: getContactStages runs 8 chunked legs at
    // once, so a per-call limit would multiply by the number of legs.
    let peak = 0;
    let live = 0;
    const leg = () =>
      chunked(idsForChunks(5), async (chunk) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return chunk;
      });
    await Promise.all([leg(), leg(), leg(), leg(), leg(), leg(), leg(), leg()]);
    expect(peak).toBeLessThanOrEqual(24);
  });

  it("applies the same ceiling to chunkedPaginated", async () => {
    let peak = 0;
    let live = 0;
    const leg = () =>
      chunkedPaginated(idsForChunks(4), async (chunk, from) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return from === 0 ? [chunk[0]] : [];
      });
    await Promise.all([leg(), leg(), leg(), leg(), leg(), leg(), leg(), leg()]);
    expect(peak).toBeLessThanOrEqual(24);
  });

  it("releases its slot when a chunk throws, so the gate cannot wedge", async () => {
    await expect(
      chunked(idsForChunks(3), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the failed run leaked its slots, this second call would hang forever.
    const rows = await chunked([1, 2, 3], async (chunk) => chunk);
    expect(rows).toEqual([1, 2, 3]);
  });
});
