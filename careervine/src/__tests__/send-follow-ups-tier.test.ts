import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: the send-follow-ups cron branches on tier. A CONNECTED user without
 * followups:auto (free / opted-out) has due messages parked as awaiting_review
 * and Gmail is never touched — the branch runs BEFORE the Gmail fetch, so a free
 * user's gmail.send token never reaches the read-scoped threads.get. A premium
 * user (followups:auto) takes the normal Gmail path. capabilitiesFor is real.
 */

const getGmailClientSpy = vi.fn();
const sendTrackedEmailSpy = vi.fn(async () => {});

const state: {
  pendingMessages: unknown[];
  connections: unknown[];
  activeUserIds: string[];
  updates: { table: string; patch: Record<string, unknown> }[];
} = { pendingMessages: [], connections: [], activeUserIds: [], updates: [] };

vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify() {
      return Promise.resolve(true);
    }
  },
}));

vi.mock("@/lib/cron-guard", () => ({
  withCronGuard: (_name: string, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/user-status", () => ({
  filterActiveUserIds: async () => new Set(state.activeUserIds),
}));

vi.mock("@/lib/gmail", () => ({
  getGmailClient: (...a: unknown[]) => getGmailClientSpy(...a),
  activateContactByEmail: async () => {},
}));

vi.mock("@/lib/email-send", () => ({
  sendTrackedEmail: (...a: unknown[]) => sendTrackedEmailSpy(...a),
  SendPolicyError: class extends Error {},
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      let mode: "read" | "update" = "read";
      let isCount = false;
      const b: Record<string, unknown> = {
        select: (_s: string, opts?: { count?: string }) => {
          if (opts?.count) isCount = true;
          return b;
        },
        update: (patch: Record<string, unknown>) => {
          mode = "update";
          state.updates.push({ table, patch });
          return b;
        },
        eq: () => b,
        in: () => b,
        lte: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        single: async () => ({ data: null }), // atomic claim "fails" -> premium send loop skips
        then: (resolve: (v: unknown) => void) => {
          if (mode === "update") return resolve({ error: null });
          if (isCount) return resolve({ count: 0 });
          if (table === "email_follow_up_messages") return resolve({ data: state.pendingMessages });
          if (table === "gmail_connections") return resolve({ data: state.connections });
          return resolve({ data: [] });
        },
      };
      return b;
    },
  }),
}));

import { POST } from "@/app/api/cron/send-follow-ups/route";

function dueMessage(userId: string) {
  return {
    id: 100,
    follow_up_id: 1,
    subject: "Nudge",
    body_html: "<p>hi</p>",
    scheduled_send_at: "2026-07-12T00:00:00.000Z",
    email_follow_ups: {
      id: 1,
      user_id: userId,
      thread_id: "t-1",
      recipient_email: "amy@y.com",
      contact_name: "Amy",
      original_gmail_message_id: "gmid-1",
      original_subject: "Intro",
      status: "active",
    },
  };
}

const req = {
  text: async () => "",
  headers: { get: () => "" },
  url: "http://localhost:3000/api/cron/send-follow-ups",
} as never;

describe("send-follow-ups cron — tier branch (CAR-102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pendingMessages = [];
    state.connections = [];
    state.activeUserIds = [];
    state.updates = [];
    getGmailClientSpy.mockReset();
  });

  it("free/connected (no followups:auto) -> parks awaiting_review, never touches Gmail", async () => {
    state.pendingMessages = [dueMessage("free-1")];
    state.connections = [
      { user_id: "free-1", gmail_address: "free@x.com", modify_scope_granted: false, automatic_features_enabled: false, premium_enabled: true },
    ];
    state.activeUserIds = ["free-1"];

    const res = await POST(req);
    const data = await res.json();

    expect(getGmailClientSpy).not.toHaveBeenCalled();
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    expect(state.updates.some((u) => u.table === "email_follow_up_messages" && u.patch.status === "awaiting_review")).toBe(true);
    expect(data.awaitingReview).toBeGreaterThan(0);
  });

  it("premium (followups:auto) -> takes the Gmail path (getGmailClient called)", async () => {
    getGmailClientSpy.mockResolvedValue({
      users: { threads: { get: async () => ({ data: { messages: [{ payload: { headers: [] } }] } }) } },
    });
    state.pendingMessages = [dueMessage("prem-1")];
    state.connections = [
      { user_id: "prem-1", gmail_address: "prem@x.com", modify_scope_granted: true, automatic_features_enabled: true, premium_enabled: true },
    ];
    state.activeUserIds = ["prem-1"];

    const res = await POST(req);
    await res.json();

    expect(getGmailClientSpy).toHaveBeenCalledWith("prem-1");
    expect(state.updates.some((u) => u.patch.status === "awaiting_review")).toBe(false);
  });

  it("premium but automation OFF (no followups:auto, no outreach:portal) -> holds pending: no park, no Gmail", async () => {
    // Premium (modify granted + premium_enabled) so NOT the free portal tier, but
    // automatic_features_enabled=false means no auto-send. The message must simply
    // stay pending (held) — parking it as awaiting_review would strand it behind
    // the Outreach portal a premium user never sees (review N2).
    state.pendingMessages = [dueMessage("prem-off")];
    state.connections = [
      { user_id: "prem-off", gmail_address: "premoff@x.com", modify_scope_granted: true, automatic_features_enabled: false, premium_enabled: true },
    ];
    state.activeUserIds = ["prem-off"];

    const res = await POST(req);
    const data = await res.json();

    expect(getGmailClientSpy).not.toHaveBeenCalled();
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    expect(state.updates.some((u) => u.patch.status === "awaiting_review")).toBe(false);
    expect(data.awaitingReview).toBe(0);
  });
});
