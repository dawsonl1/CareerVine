import { describe, it, expect, vi, beforeEach } from "vitest";

/** CAR-143 (R5.3): shared-key spend accounting is fail-closed on reads. */

const mockMaybeSingle = vi.fn();
const mockRpc = vi.fn();
const chain: Record<string, unknown> = { maybeSingle: mockMaybeSingle };
chain.select = vi.fn(() => chain);
chain.eq = vi.fn(() => chain);

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({ from: vi.fn(() => chain), rpc: mockRpc })),
}));

import {
  estimateCallCostUsd,
  currentPeriodStart,
  getSharedAiSpendUsd,
  recordSharedAiSpend,
  FLAT_CALL_COST_USD,
  SHARED_AI_SPEND_LIMIT_USD,
} from "@/lib/ai/spend";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("estimateCallCostUsd", () => {
  it("prices Responses-API usage (input/output_tokens)", () => {
    const cost = estimateCallCostUsd({ usage: { input_tokens: 1_000_000, output_tokens: 0 } });
    expect(cost).toBeCloseTo(0.25);
  });

  it("prices Chat-Completions usage (prompt/completion_tokens)", () => {
    const cost = estimateCallCostUsd({
      usage: { prompt_tokens: 0, completion_tokens: 1_000_000 },
    });
    expect(cost).toBeCloseTo(2);
  });

  it("falls back to the conservative flat estimate without usage", () => {
    expect(estimateCallCostUsd({})).toBe(FLAT_CALL_COST_USD);
    expect(estimateCallCostUsd(null)).toBe(FLAT_CALL_COST_USD);
    expect(estimateCallCostUsd("string result")).toBe(FLAT_CALL_COST_USD);
    expect(estimateCallCostUsd({ usage: { input_tokens: "garbage" } })).toBe(FLAT_CALL_COST_USD);
  });
});

describe("currentPeriodStart", () => {
  it("returns the first of the current UTC month as a DATE string", () => {
    expect(currentPeriodStart(new Date("2026-07-16T23:59:00Z"))).toBe("2026-07-01");
    expect(currentPeriodStart(new Date("2026-12-31T23:59:00Z"))).toBe("2026-12-01");
  });
});

describe("getSharedAiSpendUsd", () => {
  it("returns 0 for a user with no usage row", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getSharedAiSpendUsd("u-1")).toBe(0);
  });

  it("returns the persisted month-to-date spend", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { estimated_cost_usd: "0.42" }, error: null });
    expect(await getSharedAiSpendUsd("u-1")).toBeCloseTo(0.42);
  });

  it("fails CLOSED: throws on a lookup error instead of returning $0", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getSharedAiSpendUsd("u-1")).rejects.toThrow("shared AI spend lookup failed");
  });
});

describe("recordSharedAiSpend", () => {
  it("increments via the atomic RPC", async () => {
    mockRpc.mockResolvedValue({ error: null });
    await recordSharedAiSpend("u-1", 0.01);
    expect(mockRpc).toHaveBeenCalledWith("increment_ai_shared_usage", {
      p_user_id: "u-1",
      p_period_start: currentPeriodStart(),
      p_cost: 0.01,
    });
  });

  it("never throws on a failed write (best-effort)", async () => {
    mockRpc.mockRejectedValue(new Error("db down"));
    await expect(recordSharedAiSpend("u-1", 0.01)).resolves.toBeUndefined();
  });
});

describe("SHARED_AI_SPEND_LIMIT_USD", () => {
  it("is a small positive ceiling", () => {
    expect(SHARED_AI_SPEND_LIMIT_USD).toBeGreaterThan(0);
    expect(SHARED_AI_SPEND_LIMIT_USD).toBeLessThanOrEqual(10);
  });
});
