import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(),
}));

import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { resolveCapabilities } from "@/lib/capabilities/resolve";

/** Build a mock service client whose .from().select().eq().maybeSingle() resolves to `result`. */
function mockConnection(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  (createSupabaseServiceClient as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ from });
  return { from, select, eq, maybeSingle };
}

describe("resolveCapabilities — server resolver, fails closed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("both flags true -> full capability set", async () => {
    mockConnection({ data: { modify_scope_granted: true, automatic_features_enabled: true }, error: null });
    const caps = await resolveCapabilities("user-1");
    expect(caps.has("inbox:premium")).toBe(true);
    expect(caps.has("followups:auto")).toBe(true);
    expect(caps.size).toBe(5);
  });

  it("modify scope only -> no followups:auto", async () => {
    mockConnection({ data: { modify_scope_granted: true, automatic_features_enabled: false, premium_enabled: true }, error: null });
    const caps = await resolveCapabilities("user-1");
    expect(caps.has("inbox:premium")).toBe(true);
    expect(caps.has("followups:auto")).toBe(false);
  });

  it("connected free (modify false) -> outreach:portal only", async () => {
    mockConnection({ data: { modify_scope_granted: false, automatic_features_enabled: false, premium_enabled: true }, error: null });
    const caps = await resolveCapabilities("user-1");
    expect(caps.has("outreach:portal")).toBe(true);
    expect(caps.has("inbox:premium")).toBe(false);
    expect(caps.size).toBe(1);
  });

  it("admin down-scoped (modify held, premium_enabled false) -> outreach:portal, no premium (no reconnect)", async () => {
    mockConnection({ data: { modify_scope_granted: true, automatic_features_enabled: true, premium_enabled: false }, error: null });
    const caps = await resolveCapabilities("user-1");
    expect(caps.has("outreach:portal")).toBe(true);
    expect(caps.has("inbox:premium")).toBe(false);
    expect(caps.has("followups:auto")).toBe(false);
    expect(caps.size).toBe(1);
  });

  it("premium_enabled missing (null) -> fails OPEN to premium (never down-tier on a null)", async () => {
    mockConnection({ data: { modify_scope_granted: true, automatic_features_enabled: false }, error: null });
    const caps = await resolveCapabilities("user-1");
    expect(caps.has("inbox:premium")).toBe(true);
    expect(caps.has("outreach:portal")).toBe(false);
  });

  it("no connection row -> empty set (free, fail-closed)", async () => {
    mockConnection({ data: null, error: null });
    const caps = await resolveCapabilities("user-1");
    expect(caps.size).toBe(0);
  });

  it("DB error -> empty set (fail-closed, never grant unverified)", async () => {
    mockConnection({ data: null, error: { message: "boom" } });
    const caps = await resolveCapabilities("user-1");
    expect(caps.size).toBe(0);
  });

  it("thrown error -> empty set (fail-closed)", async () => {
    (createSupabaseServiceClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("kaboom");
    });
    const caps = await resolveCapabilities("user-1");
    expect(caps.size).toBe(0);
  });
});
