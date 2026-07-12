import { describe, it, expect, vi, beforeEach } from "vitest";

// getNetworkTierCounts calls supabase.rpc("network_tier_counts").single().
const { rpcSingle, rpcMock } = vi.hoisted(() => {
  const rpcSingle = vi.fn();
  return { rpcSingle, rpcMock: vi.fn(() => ({ single: rpcSingle })) };
});

vi.mock("@/lib/supabase/browser-client", () => ({
  createSupabaseBrowserClient: () => ({ rpc: rpcMock }),
}));

import { getNetworkTierCounts } from "@/lib/queries";

beforeEach(() => {
  rpcSingle.mockReset();
  rpcMock.mockClear();
});

describe("getNetworkTierCounts (CAR-98)", () => {
  it("calls the single network_tier_counts RPC (not per-tier HEAD queries)", async () => {
    rpcSingle.mockResolvedValue({ data: { active: 1, prospect: 2, bench: 3 }, error: null });
    await getNetworkTierCounts();
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith("network_tier_counts");
  });

  it("maps the RPC row to per-tier counts", async () => {
    rpcSingle.mockResolvedValue({ data: { active: 12, prospect: 1144, bench: 856 }, error: null });
    expect(await getNetworkTierCounts()).toEqual({ active: 12, prospect: 1144, bench: 856 });
  });

  it("coerces bigint-as-string counts to numbers", async () => {
    rpcSingle.mockResolvedValue({ data: { active: "3", prospect: "0", bench: "5" }, error: null });
    expect(await getNetworkTierCounts()).toEqual({ active: 3, prospect: 0, bench: 5 });
  });

  it("falls back to zeros on error", async () => {
    rpcSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(await getNetworkTierCounts()).toEqual({ active: 0, prospect: 0, bench: 0 });
  });

  it("falls back to zeros when no row is returned", async () => {
    rpcSingle.mockResolvedValue({ data: null, error: null });
    expect(await getNetworkTierCounts()).toEqual({ active: 0, prospect: 0, bench: 0 });
  });
});
