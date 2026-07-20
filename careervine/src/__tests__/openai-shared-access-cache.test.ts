/**
 * CAR-158: resolveSharedAccess caches its answer for 60s and fails CLOSED when
 * the entitlement read throws. Those two behaviors must not compose — caching
 * an exception-derived denial would lock an entitled user out of AI for a full
 * TTL window over one transient DB blip. A thrown read denies THIS request and
 * nothing more; genuine (non-exception) outcomes still cache normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFrom = vi.fn();
const mockServiceClient = { from: mockFrom };

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => mockServiceClient),
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: vi.fn().mockResolvedValue(undefined),
}));

import * as openaiModule from "@/lib/openai";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";

const routing = openaiModule.openaiRoutingInternals!;
const USER = "user-cache-1";

/**
 * user_ai_access mock. `error` makes the entitlement read fail the way a
 * transient outage does, which must() turns into a throw.
 */
function accessMock(opts: { row?: Record<string, unknown> | null; error?: string } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue(
    opts.error
      ? { data: null, error: { message: opts.error } }
      : { data: opts.row ?? null, error: null },
  );
  const upsert = vi.fn().mockResolvedValue({ count: 0, error: null });
  const lte = vi.fn().mockResolvedValue({ count: 0, error: null });
  const chain: Record<string, unknown> = { maybeSingle, upsert, lte };
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  mockFrom.mockImplementation(() => chain);
  return { maybeSingle, upsert };
}

/** A permanent (non-trial) grant. */
const GRANTED = { shared_access: true, expires_at: null, granted_by: "admin" };
/** A row that exists with no entitlement — a genuine, cacheable denial. */
const CUTOFF = { shared_access: false, expires_at: null, granted_by: null };

describe("resolveSharedAccess cache (CAR-158)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceClient).mockImplementation(() => mockServiceClient as never);
    openaiModule.evictSharedAccessCache(USER);
  });

  it("does not cache a denial derived from a thrown read", async () => {
    const failing = accessMock({ error: "connection reset" });

    // Fails closed, as it must — spending on a key we cannot verify is worse.
    await expect(routing.resolveSharedAccess(USER)).resolves.toEqual({
      granted: false,
      trialExpired: false,
    });
    expect(failing.maybeSingle).toHaveBeenCalledTimes(1);
    // The trial must not arm off a failed read either.
    expect(failing.upsert).not.toHaveBeenCalled();

    // The very next request re-reads instead of replaying the stale denial.
    const recovered = accessMock({ row: GRANTED });
    await expect(routing.resolveSharedAccess(USER)).resolves.toEqual({
      granted: true,
      trialExpired: false,
    });
    expect(recovered.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("still caches a genuine denial (row present, no entitlement)", async () => {
    const cutoff = accessMock({ row: CUTOFF });

    await expect(routing.resolveSharedAccess(USER)).resolves.toEqual({
      granted: false,
      trialExpired: false,
    });
    await expect(routing.resolveSharedAccess(USER)).resolves.toEqual({
      granted: false,
      trialExpired: false,
    });
    // Second call served from cache — the TTL is what keeps this off the hot path.
    expect(cutoff.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it("still caches a genuine grant", async () => {
    const granted = accessMock({ row: GRANTED });

    await expect(routing.resolveSharedAccess(USER)).resolves.toEqual({
      granted: true,
      trialExpired: false,
    });
    await expect(routing.resolveSharedAccess(USER)).resolves.toEqual({
      granted: true,
      trialExpired: false,
    });
    expect(granted.maybeSingle).toHaveBeenCalledTimes(1);
  });
});
