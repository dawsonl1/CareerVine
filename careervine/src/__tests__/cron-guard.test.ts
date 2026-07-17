import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-149 F43 (shared test): the cron routes run outside withApiHandler, so a
 * crash is only surfaced to the api_error guardrail by withCronGuard's catch.
 * If that catch stops emitting trackCronError, broken releases go silent again.
 */

const trackCronErrorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/analytics/server", () => ({
  trackCronError: (route: string) => trackCronErrorSpy(route),
}));

import { NextResponse } from "next/server";
import { withCronGuard } from "@/lib/cron-guard";

describe("withCronGuard (CAR-58)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the handler's response on success and does not track", async () => {
    const res = await withCronGuard("/api/cron/x", async () =>
      NextResponse.json({ processed: 1 }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 1 });
    expect(trackCronErrorSpy).not.toHaveBeenCalled();
  });

  it("catches a thrown error, emits trackCronError, and returns 500", async () => {
    const res = await withCronGuard("/api/cron/x", async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal error" });
    expect(trackCronErrorSpy).toHaveBeenCalledWith("/api/cron/x");
  });
});
