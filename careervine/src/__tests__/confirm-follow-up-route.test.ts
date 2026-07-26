import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: POST /api/gmail/follow-ups/confirm — free-tier confirm-to-send.
 * replied=true delegates to recordThreadReply; replied=false claims the message
 * and sends it. Guards: 404 unknown/foreign, 400 not-awaiting, 409 already-claimed.
 */

let authedUser: FakeAuthUser | null = { id: "u-1" };
const state: {
  msgData: unknown;
  /** The fresh parent re-read the send-failure revert path performs (CAR-108). */
  parentRow: { status: string } | null;
  /** rows matched by the atomic claim update (1 = won, 0 = already taken). */
  claimCount: number;
  /** rows still open when the completion-count query runs (0 = parent completes). */
  completionCount: number;
  /** every update() patch, in order — the revert is the last one. */
  updates: Record<string, unknown>[];
  /** global maybeSingle counter: 1st = message read, 2nd = fresh parent read. */
  singleCalls: number;
  /** error injected into the post-send mark-sent write (CAR-207). */
  markSentError: { message: string } | null;
} = {
  msgData: null,
  parentRow: { status: "active" },
  claimCount: 1,
  completionCount: 1,
  updates: [],
  singleCalls: 0,
  markSentError: null,
};

const recordThreadReplySpy = vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; alreadyMarked: boolean }>>(async () => ({ ok: true, alreadyMarked: false }));
const sendTrackedEmailSpy = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});

vi.mock("@/lib/supabase/server-client", () => mockServerClientModule({ user: () => authedUser }));

vi.mock("@/lib/follow-up-reply", () => ({
  recordThreadReply: (...a: unknown[]) => recordThreadReplySpy(...a),
}));

vi.mock("@/lib/email-send", () => ({
  sendTrackedEmail: (...a: unknown[]) => sendTrackedEmailSpy(...a),
  SendPolicyError: class SendPolicyError extends Error {
    status: number;
    constructor(m: string, status: number) {
      super(m);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
    from: () => {
      // The claim is now a count-based update (rule 17), so it and the
      // completion-count SELECT both resolve via then() but need different
      // counts — distinguish by whether update() was called on this builder.
      let isUpdate = false;
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => {
          isUpdate = true;
          patch = p;
          return b;
        },
        eq: () => b,
        in: () => b,
        maybeSingle: async () => {
          state.singleCalls += 1;
          return { data: state.singleCalls === 1 ? state.msgData : state.parentRow };
        },
        then: (resolve: (v: unknown) => void) => {
          if (isUpdate && patch) {
            state.updates.push(patch);
            // The post-send bookkeeping write, injectable so its failure path is
            // exercised for real (CAR-207). It is the only write setting 'sent'.
            if (state.markSentError && patch.status === "sent") {
              return resolve({ count: null, error: state.markSentError });
            }
          }
          return resolve({ count: isUpdate ? state.claimCount : state.completionCount, error: null });
        },
      };
      return b;
    },
  })),
);

import { mockServerClientModule, mockServiceClientModule, type FakeAuthUser } from "./helpers/mock-supabase";
import { POST } from "@/app/api/gmail/follow-ups/confirm/route";

const parent = {
  user_id: "u-1",
  thread_id: "t-9",
  recipient_email: "amy@y.com",
  original_gmail_message_id: "gmid-1",
  status: "active",
};
const awaitingMsg = {
  status: "awaiting_review",
  subject: "Nudge",
  body_html: "<p>hi</p>",
  follow_up_id: 3,
  expires_at: "2999-01-01T00:00:00.000Z", // far future: a normal in-window parked item
  email_follow_ups: parent,
};

function makeRequest(body: unknown) {
  return {
    method: "POST",
    nextUrl: new URL("http://localhost:3000/api/gmail/follow-ups/confirm"),
    url: "http://localhost:3000/api/gmail/follow-ups/confirm",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as never;
}

async function call(body: unknown) {
  const res = await POST(makeRequest(body), { params: Promise.resolve({}) });
  return { status: res.status, data: await res.json() };
}

describe("POST /api/gmail/follow-ups/confirm (CAR-102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authedUser = { id: "u-1" };
    state.msgData = awaitingMsg;
    state.parentRow = { status: "active" };
    state.claimCount = 1;
    state.completionCount = 1;
    state.updates = [];
    state.singleCalls = 0;
    state.markSentError = null;
  });

  it("404s an unknown or foreign message", async () => {
    state.msgData = { ...awaitingMsg, email_follow_ups: { ...parent, user_id: "someone-else" } };
    const { status } = await call({ messageId: 5, replied: false });
    expect(status).toBe(404);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("400s a message that is not awaiting_review", async () => {
    state.msgData = { ...awaitingMsg, status: "pending" };
    const { status } = await call({ messageId: 5, replied: false });
    expect(status).toBe(400);
  });

  it("409s an orphaned awaiting_review message whose parent sequence is no longer active", async () => {
    // The row is still awaiting_review, but its sequence was cancelled elsewhere
    // without cascading — never confirm-send against a stale sequence (review N6).
    state.msgData = { ...awaitingMsg, email_follow_ups: { ...parent, status: "cancelled_reply" } };
    const { status } = await call({ messageId: 5, replied: false });
    expect(status).toBe(409);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("replied=true delegates to recordThreadReply (cancel + activate + fire), no send", async () => {
    const { status, data } = await call({ messageId: 5, replied: true });
    expect(status).toBe(200);
    expect(data.replied).toBe(true);
    expect(recordThreadReplySpy).toHaveBeenCalledWith("u-1", "t-9", "amy@y.com");
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("replied=false claims the message and sends it", async () => {
    const { status, data } = await call({ messageId: 5, replied: false });
    expect(status).toBe(200);
    expect(data.sent).toBe(true);
    expect(sendTrackedEmailSpy).toHaveBeenCalled();
    expect(recordThreadReplySpy).not.toHaveBeenCalled();
  });

  it("accepts an EXPIRED message and sends it (CAR-105 keeps expired one-click sendable)", async () => {
    state.msgData = { ...awaitingMsg, status: "expired" };
    const { status, data } = await call({ messageId: 5, replied: false });
    expect(status).toBe(200);
    expect(data.sent).toBe(true);
    expect(sendTrackedEmailSpy).toHaveBeenCalled();
  });

  it("409s when the message can no longer be claimed (already processed)", async () => {
    state.claimCount = 0;
    const { status } = await call({ messageId: 5, replied: false });
    expect(status).toBe(409);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("send failure reverts to the deadline-derived status: an expired item stays expired (CAR-105)", async () => {
    // Expired-but-sendable item; send fails. The revert must keep it 'expired'
    // (derived from a past expires_at), never resurrect it as awaiting_review.
    state.msgData = { ...awaitingMsg, status: "expired", expires_at: "2000-01-01T00:00:00.000Z" };
    state.parentRow = { status: "active" };
    sendTrackedEmailSpy.mockRejectedValueOnce(new Error("smtp down"));

    const { status } = await call({ messageId: 5, replied: false });

    expect(status).toBe(400);
    // last write is the revert; it also releases the claim (CAR-139)
    expect(state.updates.at(-1)).toEqual({ status: "expired", claimed_at: null });
  });

  it("send failure under a concurrently-cancelled parent cancels the row, no orphan (CAR-108)", async () => {
    // The parent was torn down while we held the row in 'sending' (teardown can't
    // see a 'sending' row). On send failure we must NOT revert into an actionable
    // status under a cancelled parent — cancel the row to match its parent.
    state.msgData = { ...awaitingMsg, status: "awaiting_review" };
    state.parentRow = { status: "cancelled_reply" }; // fresh re-read: parent is gone
    sendTrackedEmailSpy.mockRejectedValueOnce(new Error("smtp down"));

    const { status } = await call({ messageId: 5, replied: false });

    expect(status).toBe(400);
    expect(state.updates.at(-1)).toEqual({ status: "cancelled", claimed_at: null });
  });

  it("the atomic claim stamps claimed_at so a crashed send is sweepable (CAR-139)", async () => {
    const { status } = await call({ messageId: 5, replied: false });
    expect(status).toBe(200);
    const claim = state.updates.find((u) => u.status === "sending");
    expect(claim).toBeDefined();
    expect(typeof claim!.claimed_at).toBe("string");
  });

  /**
   * CAR-207. This route is the SECOND send driver for the same row, and it had
   * the same unchecked mark-sent write as the cron. Gmail has the message; only
   * the bookkeeping failed. Reverting the claim to anything actionable would
   * render "Send now" over an email the contact already has.
   */
  it("a delivered follow-up whose mark-sent write fails is never handed back as sendable", async () => {
    state.markSentError = { message: "write conflict" };
    // Nothing open, so an unguarded fall-through WOULD complete the parent off
    // the back of a write that never landed. In production the row is still
    // 'sending' and the real count could not be 0; forcing it here is what makes
    // the early return observable rather than incidental.
    state.completionCount = 0;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { status, data } = await call({ messageId: 5, replied: false });

      expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
      // The send DID happen, so success is the honest answer to the caller.
      expect(status).toBe(200);
      expect(data).toMatchObject({ success: true, sent: true });
      // The failure is observed rather than swallowed.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("delivered but mark-sent failed"),
        expect.objectContaining({ message: "write conflict" }),
      );
      // Exactly two writes, and the row is left holding its claim. Nothing
      // actionable, nothing re-queued: the cron sweeper takes it to 'failed'.
      expect(state.updates.map((u) => u.status)).toEqual(["sending", "sent"]);
      expect(state.updates.some((u) => u.status === "awaiting_review")).toBe(false);
      expect(state.updates.some((u) => u.status === "expired")).toBe(false);
      expect(state.updates.some((u) => u.status === "pending")).toBe(false);
      // And the sequence is not closed on the strength of a failed write.
      expect(state.updates.some((u) => u.status === "completed")).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});
