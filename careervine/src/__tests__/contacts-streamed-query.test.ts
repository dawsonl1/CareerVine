import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the range() args and hand back queued page results so we can assert
// the streaming pagination (small first page, large rest) and callback order.
const mockRange = vi.fn();

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: () => ({
            order: () => ({
              range: (from: number, to: number) => mockRange(from, to),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { getContactsStreamed } from "@/lib/queries";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

beforeEach(() => {
  mockRange.mockReset();
});

describe("getContactsStreamed", () => {
  it("paints a small first page, then pages the rest in larger chunks", async () => {
    // 50 (full first page) → 1000 (full) → 3 (short, stops)
    mockRange
      .mockResolvedValueOnce({ data: rows(50), error: null })
      .mockResolvedValueOnce({ data: rows(1000), error: null })
      .mockResolvedValueOnce({ data: rows(3), error: null });

    const pages: number[] = [];
    const all = await getContactsStreamed("u1", ["active"], (r) => pages.push(r.length));

    // First range is the 50-row fast-paint window, subsequent ranges are 1000.
    expect(mockRange.mock.calls).toEqual([
      [0, 49],
      [50, 1049],
      [1050, 2049],
    ]);
    // onPage fires once per non-empty page, in arrival order.
    expect(pages).toEqual([50, 1000, 3]);
    // The accumulated return matches getContacts' full-array contract.
    expect(all).toHaveLength(1053);
  });

  it("stops after one page when the first page is not full and skips the empty callback", async () => {
    mockRange.mockResolvedValueOnce({ data: rows(12), error: null });

    const pages: number[] = [];
    const all = await getContactsStreamed("u1", ["active"], (r) => pages.push(r.length));

    expect(mockRange).toHaveBeenCalledTimes(1);
    expect(pages).toEqual([12]);
    expect(all).toHaveLength(12);
  });

  it("never invokes onPage for an empty result set", async () => {
    mockRange.mockResolvedValueOnce({ data: [], error: null });

    const onPage = vi.fn();
    const all = await getContactsStreamed("u1", ["active"], onPage);

    expect(onPage).not.toHaveBeenCalled();
    expect(all).toHaveLength(0);
  });

  it("throws on a query error", async () => {
    mockRange.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(
      getContactsStreamed("u1", ["active"], () => {}),
    ).rejects.toBeTruthy();
  });
});
