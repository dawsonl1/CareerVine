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

function makeReq(
  body = '{"subscriptionIds":[1]}',
  signature = "valid-sig",
  extraHeaders: Record<string, string> = {},
): Req {
  const lower = Object.fromEntries(
    Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    text: async () => body,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key === "upstash-signature") return signature;
        return key in lower ? lower[key] : null;
      },
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
    // Second arg is the auth source the route branches on (CAR-215).
    expect(handler).toHaveBeenCalledWith("BODY-123", "qstash");
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

/**
 * CAR-215: the A1 watcher drives the send routes at ~15s resolution and cannot
 * produce a QStash signature, so a dedicated bearer is accepted alongside it.
 *
 * The risk being managed: this is a second way into routes that send email. The
 * tests below pin that it fails closed when unset, that it does not accept a
 * near-miss, and that adding it did not weaken the signature path.
 */
describe("cron trigger bearer (CAR-215)", () => {
  const SECRET = "s3cret-watcher-token";
  const savedSecret = process.env.CRON_TRIGGER_SECRET;
  const savedCurrent = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const savedNext = process.env.QSTASH_NEXT_SIGNING_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    verifySpy.mockResolvedValue(true);
    process.env.CRON_TRIGGER_SECRET = SECRET;
    process.env.QSTASH_CURRENT_SIGNING_KEY = "test-current";
    process.env.QSTASH_NEXT_SIGNING_KEY = "test-next";
    resetQStashReceiverForTests();
  });

  afterEach(() => {
    process.env.CRON_TRIGGER_SECRET = savedSecret;
    process.env.QSTASH_CURRENT_SIGNING_KEY = savedCurrent;
    process.env.QSTASH_NEXT_SIGNING_KEY = savedNext;
    resetQStashReceiverForTests();
  });

  const bearer = (token: string) => makeReq("{}", "no-such-sig", { Authorization: `Bearer ${token}` });

  it("runs the handler on a correct bearer without consulting the signature", async () => {
    const handler = vi.fn(async (body: string) => NextResponse.json({ echoed: body }));
    const res = await withQStashVerification(bearer(SECRET), handler);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith("{}", "watcher");
    // The high-frequency caller must not pay for Receiver verification.
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("refuses (401) a wrong bearer, falling through to the invalid signature", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(bearer("wrong-token"), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a bearer that is a prefix of the real secret", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(bearer(SECRET.slice(0, -1)), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a bearer with the secret plus trailing content", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(bearer(`${SECRET}x`), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_TRIGGER_SECRET is unset, even for an empty bearer", async () => {
    delete process.env.CRON_TRIGGER_SECRET;
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    for (const token of ["", "anything", "undefined"]) {
      const res = await withQStashVerification(bearer(token), handler);
      expect(res.status, `token=${token}`).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a non-Bearer Authorization scheme carrying the secret", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const req = makeReq("{}", "no-such-sig", { Authorization: `Basic ${SECRET}` });
    const res = await withQStashVerification(req, handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("still accepts a valid QStash signature when no bearer is present", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(makeReq(), handler);
    expect(res.status).toBe(200);
    expect(verifySpy).toHaveBeenCalled();
  });
});
