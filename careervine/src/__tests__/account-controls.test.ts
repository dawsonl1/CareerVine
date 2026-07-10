import { describe, it, expect } from "vitest";
import { getApifyControls } from "@/lib/apify/account-controls";

// Minimal PostgREST-shaped stub: from().select().eq().maybeSingle()
function stubService(result: { data: unknown; error: { message: string } | null }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => result,
        }),
      }),
    }),
  } as unknown as Parameters<typeof getApifyControls>[0];
}

describe("getApifyControls (plan 36)", () => {
  it("maps the flags through", async () => {
    const service = stubService({
      data: { apify_enrichment_enabled: true, diff_analysis_enabled: false },
      error: null,
    });
    expect(await getApifyControls(service, "u-1")).toEqual({
      enrichmentEnabled: true,
      diffEnabled: false,
    });
  });

  it("fails CLOSED on a read error — a paid run must never start blind", async () => {
    const service = stubService({ data: null, error: { message: "boom" } });
    expect(await getApifyControls(service, "u-1")).toEqual({
      enrichmentEnabled: false,
      diffEnabled: false,
    });
  });

  it("fails CLOSED on a missing user row", async () => {
    const service = stubService({ data: null, error: null });
    expect(await getApifyControls(service, "u-1")).toEqual({
      enrichmentEnabled: false,
      diffEnabled: false,
    });
  });
});
