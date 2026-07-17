import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * CAR-149 F43: the shared QStash chokepoint. These tests fail if the 401 path
 * or the empty-key guard is removed — the invisible-wiring regressions the old
 * per-route inline verify blocks allowed (each cron test mocks the Receiver
 * class, so none of them exercise the empty-key refusal).
 */

// Controllable Receiver: verify resolves unless a test makes it reject.
const verifySpy = vi.fn().mockResolvedValue(true);
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    constructor(_keys: unknown) {}
    verify(args: unknown) {
      return verifySpy(args);
    }
  },
}));

import { NextResponse } from "next/server";
import {
  withQStashVerification,
  resetQStashReceiverForTests,
} from "@/lib/qstash-verify";

type Req = Parameters<typeof withQStashVerification>[0];

function makeReq(body = '{"subscriptionIds":[1]}', signature = "valid-sig"): Req {
  return {
    text: async () => body,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "upstash-signature" ? signature : null,
    },
    url: "https://www.careervine.app/api/queue/bundle-sync",
  } as unknown as Req;
}

describe("withQStashVerification (CAR-149 F43)", () => {
  const savedCurrent = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const savedNext = process.env.QSTASH_NEXT_SIGNING_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    verifySpy.mockResolvedValue(true);
    process.env.QSTASH_CURRENT_SIGNING_KEY = savedCurrent || "test-current";
    process.env.QSTASH_NEXT_SIGNING_KEY = savedNext || "test-next";
    resetQStashReceiverForTests();
  });

  afterEach(() => {
    process.env.QSTASH_CURRENT_SIGNING_KEY = savedCurrent;
    process.env.QSTASH_NEXT_SIGNING_KEY = savedNext;
    resetQStashReceiverForTests();
  });

  it("runs the handler with the verified body on a valid signature", async () => {
    const handler = vi.fn(async (body: string) =>
      NextResponse.json({ echoed: body }),
    );
    const res = await withQStashVerification(makeReq("BODY-123"), handler);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith("BODY-123");
    expect(await res.json()).toEqual({ echoed: "BODY-123" });
  });

  it("returns 401 and never runs the handler on an invalid signature", async () => {
    verifySpy.mockRejectedValueOnce(new Error("bad signature"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(makeReq(), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses (401) when the signing keys are unset — without calling verify", async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    resetQStashReceiverForTests();
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(makeReq(), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("refuses (401) when only one signing key is present", async () => {
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    resetQStashReceiverForTests();
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(makeReq(), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });
});
