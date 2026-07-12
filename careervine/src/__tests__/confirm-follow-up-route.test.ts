import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: POST /api/gmail/follow-ups/confirm — free-tier confirm-to-send.
 * replied=true delegates to recordThreadReply; replied=false claims the message
 * and sends it. Guards: 404 unknown/foreign, 400 not-awaiting, 409 already-claimed.
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };
const state: {
  msgData: unknown;
  claimed: unknown;
  count: number;
  singleCall: number;
} = { msgData: null, claimed: { id: 5 }, count: 0, singleCall: 0 };

const recordThreadReplySpy = vi.fn(async () => ({ ok: true, alreadyMarked: false }));
const sendTrackedEmailSpy = vi.fn(async () => {});

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
      const b: Record<string, unknown> = {
        select: () => b,
        update: () => b,
        eq: () => b,
        in: () => b,
        maybeSingle: async () => {
          state.singleCall += 1;
          return state.singleCall === 1 ? { data: state.msgData } : { data: state.claimed };
        },
        then: (resolve: (v: unknown) => void) => resolve({ count: state.count, error: null }),
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
};
const awaitingMsg = {
  status: "awaiting_review",
  subject: "Nudge",
  body_html: "<p>hi</p>",
  follow_up_id: 3,
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
    state.claimed = { id: 5 };
    state.count = 0;
    state.singleCall = 0;
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

  it("409s when the message can no longer be claimed (already processed)", async () => {
    state.claimed = null;
    const { status } = await call({ messageId: 5, replied: false });
    expect(status).toBe(409);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });
});
