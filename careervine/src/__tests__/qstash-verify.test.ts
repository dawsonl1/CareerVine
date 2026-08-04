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

/**
 * The URL a request models. It reaches `receiver.verify({ url })`, so a request
 * built here is nominally "a call to that route".
 *
 * Callers pass it explicitly (CAR-220). It used to be hardcoded to
 * `/api/queue/bundle-sync` for every request in the file, including the whole
 * cron-bearer suite — so the tests that documented "the watcher may trigger a
 * send sweep" were in fact modelling the bundle fan-out queue, and the wrapper
 * genuinely did accept the bearer there. The hardcoded URL was the scoping bug
 * written down.
 */
const SEND_ROUTE = "https://www.careervine.app/api/cron/send-scheduled-emails";
const QUEUE_ROUTE = "https://www.careervine.app/api/queue/bundle-sync";

interface ReqInit {
  body?: string;
  signature?: string;
  headers?: Record<string, string>;
  url?: string;
}

function makeReq({
  body = '{"subscriptionIds":[1]}',
  signature = "valid-sig",
  headers = {},
  url = QUEUE_ROUTE,
}: ReqInit = {}): Req {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
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
    url,
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
    const res = await withQStashVerification(makeReq({ body: "BODY-123" }), handler);
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
 *
 * CAR-220: every request here now opts in explicitly with `allowCronBearer` and
 * models a send route. The refusal side — what an un-opted route does with the
 * same bearer — is the suite below this one.
 */
describe("cron trigger bearer, on a route that opts in (CAR-215)", () => {
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

  const bearer = (token: string) =>
    makeReq({
      body: "{}",
      signature: "no-such-sig",
      headers: { Authorization: `Bearer ${token}` },
      url: SEND_ROUTE,
    });
  const OPEN = { allowCronBearer: true } as const;

  it("runs the handler on a correct bearer without consulting the signature", async () => {
    const handler = vi.fn(async (body: string) => NextResponse.json({ echoed: body }));
    const res = await withQStashVerification(bearer(SECRET), handler, OPEN);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith("{}", "watcher");
    // The high-frequency caller must not pay for Receiver verification.
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("refuses (401) a wrong bearer, falling through to the invalid signature", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(bearer("wrong-token"), handler, OPEN);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a bearer that is a prefix of the real secret", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(bearer(SECRET.slice(0, -1)), handler, OPEN);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a bearer with the secret plus trailing content", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(bearer(`${SECRET}x`), handler, OPEN);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_TRIGGER_SECRET is unset, even for an empty bearer", async () => {
    delete process.env.CRON_TRIGGER_SECRET;
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    for (const token of ["", "anything", "undefined"]) {
      const res = await withQStashVerification(bearer(token), handler, OPEN);
      expect(res.status, `token=${token}`).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a non-Bearer Authorization scheme carrying the secret", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const req = makeReq({
      body: "{}",
      signature: "no-such-sig",
      headers: { Authorization: `Basic ${SECRET}` },
      url: SEND_ROUTE,
    });
    const res = await withQStashVerification(req, handler, OPEN);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("still accepts a valid QStash signature when no bearer is present", async () => {
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(makeReq({ url: SEND_ROUTE }), handler, OPEN);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.any(String), "qstash");
    expect(verifySpy).toHaveBeenCalled();
  });
});

/**
 * CAR-220: the bearer is scoped to routes that ask for it, and the default is
 * closed.
 *
 * CAR-215 checked the bearer at this shared chokepoint with no route scoping,
 * so all nine consumers accepted it: the two send routes it was minted for,
 * plus the two destructive purges, the two paid-Apify routes, the QStash
 * fan-out, the nudge mailer, and the bundle-sync queue — whose request body had
 * until then been bound by the QStash signature and no longer was.
 *
 * These tests assert the wrapper's own behaviour with and without the flag.
 * Which real routes pass it is a separate claim, pinned in
 * `src/__tests__/route-auth-inventory.test.ts`.
 */
describe("cron bearer scoping (CAR-220)", () => {
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

  /** A correct bearer aimed at a route that never asked for one. */
  const watcherCall = () =>
    makeReq({
      body: '{"subscriptionIds":[1]}',
      signature: "no-such-sig",
      headers: { Authorization: `Bearer ${SECRET}` },
      url: QUEUE_ROUTE,
    });

  it("refuses (401) a correct bearer when the route passes no options", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(watcherCall(), handler);
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses (401) a correct bearer when options omit allowCronBearer", async () => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(watcherCall(), handler, {});
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["false", false as const],
    ["undefined", undefined],
  ])("refuses (401) a correct bearer when allowCronBearer is %s", async (_label, flag) => {
    verifySpy.mockRejectedValue(new Error("bad sig"));
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(watcherCall(), handler, {
      allowCronBearer: flag,
    });
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not consult the bearer at all on an un-opted route: a valid signature wins", async () => {
    // Same request, valid signature this time. It must be admitted as "qstash",
    // never as "watcher" — the source the route branches on to stamp liveness.
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(watcherCall(), handler);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith('{"subscriptionIds":[1]}', "qstash");
    expect(verifySpy).toHaveBeenCalled();
  });

  it("leaves the signature path untouched with the flag off (valid → 200, invalid → 401)", async () => {
    const handler = vi.fn(async (body: string) => NextResponse.json({ echoed: body }));
    const ok = await withQStashVerification(makeReq({ body: "SIGNED" }), handler);
    expect(ok.status).toBe(200);
    expect(handler).toHaveBeenCalledWith("SIGNED", "qstash");

    verifySpy.mockRejectedValueOnce(new Error("bad sig"));
    const bad = await withQStashVerification(makeReq({ body: "SIGNED" }), handler);
    expect(bad.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("leaves the signature path untouched with the flag on (valid → 200, invalid → 401)", async () => {
    const OPEN = { allowCronBearer: true } as const;
    const handler = vi.fn(async (body: string) => NextResponse.json({ echoed: body }));
    const ok = await withQStashVerification(makeReq({ body: "SIGNED", url: SEND_ROUTE }), handler, OPEN);
    expect(ok.status).toBe(200);
    expect(handler).toHaveBeenCalledWith("SIGNED", "qstash");

    verifySpy.mockRejectedValueOnce(new Error("bad sig"));
    const bad = await withQStashVerification(makeReq({ body: "SIGNED", url: SEND_ROUTE }), handler, OPEN);
    expect(bad.status).toBe(401);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("still refuses (401) with the flag on when the signing keys are unset and no bearer is presented", async () => {
    // The flag must not become a second way to make the empty-key guard permissive.
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;
    delete process.env.QSTASH_NEXT_SIGNING_KEY;
    resetQStashReceiverForTests();
    const handler = vi.fn(async () => NextResponse.json({ ran: true }));
    const res = await withQStashVerification(makeReq({ url: SEND_ROUTE }), handler, {
      allowCronBearer: true,
    });
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });
});
