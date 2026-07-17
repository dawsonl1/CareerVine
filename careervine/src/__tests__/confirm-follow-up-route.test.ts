import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: POST /api/gmail/follow-ups/confirm — free-tier confirm-to-send.
 * replied=true delegates to recordThreadReply; replied=false claims the message
 * and sends it. Guards: 404 unknown/foreign, 400 not-awaiting, 409 already-claimed.
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };
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
} = {
  msgData: null,
  parentRow: { status: "active" },
  claimCount: 1,
  completionCount: 1,
  updates: [],
  singleCalls: 0,
};

const recordThreadReplySpy = vi.fn<(...a: unknown[]) => Promise<{ ok: boolean; alreadyMarked: boolean }>>(async () => ({ ok: true, alreadyMarked: false }));
const sendTrackedEmailSpy = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

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

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
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
          if (isUpdate && patch) state.updates.push(patch);
          return resolve({ count: isUpdate ? state.claimCount : state.completionCount, error: null });
        },
      };
      return b;
    },
  })),
}));

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
    expect(state.updates.at(-1)).toEqual({ status: "expired" }); // last write is the revert
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
    expect(state.updates.at(-1)).toEqual({ status: "cancelled" });
  });
});
