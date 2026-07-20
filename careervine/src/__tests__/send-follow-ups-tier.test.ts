import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-102: the send-follow-ups cron branches on tier. A CONNECTED user without
 * followups:auto (free / opted-out) has due messages parked as awaiting_review
 * and Gmail is never touched — the branch runs BEFORE the Gmail fetch, so a free
 * user's gmail.send token never reaches the read-scoped threads.get. A premium
 * user (followups:auto) takes the normal Gmail path. capabilitiesFor is real.
 */

const getGmailClientSpy = vi.fn();
const sendTrackedEmailSpy = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});

const state: {
  pendingMessages: unknown[];
  connections: unknown[];
  activeUserIds: string[];
  /** Every update() with its captured filters, in order. */
  updates: { table: string; patch: Record<string, unknown>; filters: Array<[string, ...unknown[]]> }[];
  /** count returned for count-tracked updates (the 'sending' CAS claim). 1 = claim wins. */
  claimCount: number;
  /** rows the stale-claim sweep SELECT returns (CAR-139): [{id, email_follow_ups:{status}}]. */
  staleRows: unknown[];
  /** error injected into the sweep SELECT (fail-loud coverage, CAR-139). */
  sweepReadError: { message: string } | null;
  /** error injected into the due-messages read (fail-loud coverage, CAR-139). */
  dueReadError: { message: string } | null;
  /** error injected into the gmail_connections prefetch (fail-loud, CAR-153). */
  connectionsReadError: { message: string } | null;
} = { pendingMessages: [], connections: [], activeUserIds: [], updates: [], claimCount: 1, staleRows: [], sweepReadError: null, dueReadError: null, connectionsReadError: null };

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

vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: (...a: unknown[]) => getGmailClientSpy(...a),
}));

const activateContactSpy = vi.fn(async () => {});
vi.mock("@/lib/gmail", () => ({
  activateContactByEmail: (...a: unknown[]) => activateContactSpy(...(a as [])),
}));

vi.mock("@/lib/email-send", () => ({
  sendTrackedEmail: (...a: unknown[]) => sendTrackedEmailSpy(...a),
  // Mirrors the real class (message + numeric status) so the cron's
  // 429-vs-other-policy-vs-infrastructure branch is exercised for real.
  SendPolicyError: class SendPolicyError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "SendPolicyError";
      this.status = status;
    }
  },
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      let mode: "read" | "update" = "read";
      let isCount = false;
      const filters: Array<[string, ...unknown[]]> = [];
      const b: Record<string, unknown> = {
        select: (_s: string, opts?: { count?: string }) => {
          if (opts?.count) isCount = true;
          return b;
        },
        update: (patch: Record<string, unknown>, opts?: { count?: string }) => {
          mode = "update";
          if (opts?.count) isCount = true;
          state.updates.push({ table, patch, filters });
          return b;
        },
        eq: (col: string, val: unknown) => { filters.push(["eq", col, val]); return b; },
        in: (col: string, val: unknown) => { filters.push(["in", col, val]); return b; },
        lte: (col: string, val: unknown) => { filters.push(["lte", col, val]); return b; },
        lt: (col: string, val: unknown) => { filters.push(["lt", col, val]); return b; },
        not: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => void) => {
          const hasEq = (c: string, v: unknown) => filters.some((f) => f[0] === "eq" && f[1] === c && f[2] === v);
          const hasLt = (c: string) => filters.some((f) => f[0] === "lt" && f[1] === c);
          if (mode === "update") {
            // Only the CAS claim is count-tracked; sweep-partition + free-park writes aren't.
            return resolve({ error: null, count: isCount ? state.claimCount : null });
          }
          if (isCount) return resolve({ count: 0 }); // completion-count select
          if (table === "email_follow_up_messages") {
            // Stale-claim sweep SELECT: status='sending' AND claimed_at < cutoff.
            if (hasEq("status", "sending") && hasLt("claimed_at")) {
              if (state.sweepReadError) return resolve({ data: null, error: state.sweepReadError });
              return resolve({ data: state.staleRows, error: null });
            }
            // Due-messages query.
            if (state.dueReadError) return resolve({ data: null, error: state.dueReadError });
            return resolve({ data: state.pendingMessages, error: null });
          }
          if (table === "gmail_connections") {
            if (state.connectionsReadError) return resolve({ data: null, error: state.connectionsReadError });
            return resolve({ data: state.connections, error: null });
          }
          return resolve({ data: [] });
        },
      };
      return b;
    },
  }),
}));

import { POST } from "@/app/api/cron/send-follow-ups/route";
// Resolves to the mocked class above, so `instanceof` inside the route matches.
import { SendPolicyError } from "@/lib/email-send";

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
    state.claimCount = 1;
    state.staleRows = [];
    state.sweepReadError = null;
    state.dueReadError = null;
    state.connectionsReadError = null;
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

  it("premium, claim wins (count=1) -> sends and marks the message sent (CAR-132)", async () => {
    // Success path: the CAS claim reports count=1, so the send MUST happen and
    // the row MUST be marked 'sent'. Before CAR-132 this path had zero coverage
    // (the old mock hardcoded the claim as failing) so the audit's claim-detection
    // concern was untestable.
    getGmailClientSpy.mockResolvedValue({
      users: { threads: { get: async () => ({ data: { messages: [{ payload: { headers: [] } }] } }) } },
    });
    state.pendingMessages = [dueMessage("prem-1")];
    state.connections = [
      { user_id: "prem-1", gmail_address: "prem@x.com", modify_scope_granted: true, automatic_features_enabled: true, premium_enabled: true },
    ];
    state.activeUserIds = ["prem-1"];

    const res = await POST(req);
    const data = await res.json();

    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendTrackedEmailSpy).toHaveBeenCalledWith(
      "prem-1",
      expect.objectContaining({ to: "amy@y.com", subject: "Nudge", threadId: "t-1" }),
      { isFollowUp: true },
    );
    const claimIdx = state.updates.findIndex((u) => u.table === "email_follow_up_messages" && u.patch.status === "sending");
    const sentIdx = state.updates.findIndex((u) => u.table === "email_follow_up_messages" && u.patch.status === "sent");
    expect(claimIdx).toBeGreaterThanOrEqual(0);
    expect(sentIdx).toBeGreaterThan(claimIdx);
    expect(data.sent).toBe(1);
  });

  it("premium, claim contested (count=0) -> skips without sending", async () => {
    getGmailClientSpy.mockResolvedValue({
      users: { threads: { get: async () => ({ data: { messages: [{ payload: { headers: [] } }] } }) } },
    });
    state.pendingMessages = [dueMessage("prem-1")];
    state.connections = [
      { user_id: "prem-1", gmail_address: "prem@x.com", modify_scope_granted: true, automatic_features_enabled: true, premium_enabled: true },
    ];
    state.activeUserIds = ["prem-1"];
    state.claimCount = 0;

    const res = await POST(req);
    const data = await res.json();

    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    expect(state.updates.some((u) => u.patch.status === "sent")).toBe(false);
    expect(data.sent).toBe(0);
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

describe("send-follow-ups cron — alias-aware reply detection (CAR-153/R2.5)", () => {
  const threadWithFroms = (...froms: string[]) => ({
    users: {
      threads: {
        get: async () => ({
          data: {
            messages: froms.map((value) => ({
              payload: { headers: [{ name: "From", value }] },
            })),
          },
        }),
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.pendingMessages = [dueMessage("prem-1")];
    state.connections = [
      {
        user_id: "prem-1",
        gmail_address: "prem@x.com",
        send_as_aliases: ["prem@alias.dev"],
        modify_scope_granted: true,
        automatic_features_enabled: true,
        premium_enabled: true,
      },
    ];
    state.activeUserIds = ["prem-1"];
    state.updates = [];
    state.claimCount = 1;
    state.staleRows = [];
    state.sweepReadError = null;
    state.dueReadError = null;
    state.connectionsReadError = null;
    getGmailClientSpy.mockReset();
  });

  it("the user's own alias-From thread message is NOT a reply: no cancel, no activation, send proceeds", async () => {
    getGmailClientSpy.mockResolvedValue(
      threadWithFroms("Me <prem@x.com>", "Me <Prem@Alias.DEV>"),
    );

    const res = await POST(req);
    const data = await res.json();

    expect(state.updates.some((u) => u.patch.status === "cancelled_reply")).toBe(false);
    expect(activateContactSpy).not.toHaveBeenCalled();
    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(data.cancelled).toBe(0);
  });

  it("a genuine contact reply still cancels the sequence and activates the contact", async () => {
    getGmailClientSpy.mockResolvedValue(
      threadWithFroms("Me <prem@x.com>", "Amy <Amy@Y.com>"),
    );

    const res = await POST(req);
    const data = await res.json();

    expect(state.updates.some((u) => u.table === "email_follow_ups" && u.patch.status === "cancelled_reply")).toBe(true);
    expect(activateContactSpy).toHaveBeenCalledWith("prem-1", "amy@y.com");
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    expect(data.cancelled).toBeGreaterThan(0);
  });

  it("a From header that fails to parse to an address is not treated as a reply", async () => {
    // Old substring quirk: `!"".includes(userEmail)` was TRUE for a blank
    // From against a non-empty stored address, so a headerless message was
    // falsely flagged as a reply. The set test must not repeat that: an
    // unparseable From proves nothing about who wrote it.
    getGmailClientSpy.mockResolvedValue(threadWithFroms("prem@x.com", ""));

    const res = await POST(req);
    const data = await res.json();

    expect(state.updates.some((u) => u.patch.status === "cancelled_reply")).toBe(false);
    expect(data.cancelled).toBe(0);
  });

  it("an NDR (mailer-daemon) in the thread is NOT a reply: no cancel, no activation, send proceeds", async () => {
    // A bounce is a delivery failure — treating it as "they replied" would
    // cancel the sequence AND activate the very contact whose address just
    // bounced. detectBounces owns NDRs (cancelled_bounce).
    getGmailClientSpy.mockResolvedValue(
      threadWithFroms("prem@x.com", "Mail Delivery Subsystem <mailer-daemon@googlemail.com>"),
    );

    const res = await POST(req);
    const data = await res.json();

    expect(state.updates.some((u) => u.patch.status === "cancelled_reply")).toBe(false);
    expect(activateContactSpy).not.toHaveBeenCalled();
    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(data.cancelled).toBe(0);
  });

  it("a user missing from the connections prefetch (empty own-set) is conservative: no cancel", async () => {
    // Ownership unknown must NOT invert into "every message is a reply" —
    // that would terminally cancel and falsely activate. (The old code's
    // degenerate case was equally conservative: it flagged nothing.)
    state.connections = [];

    getGmailClientSpy.mockResolvedValue(threadWithFroms("prem@x.com", "prem@x.com"));

    const res = await POST(req);
    const data = await res.json();

    expect(state.updates.some((u) => u.patch.status === "cancelled_reply")).toBe(false);
    expect(activateContactSpy).not.toHaveBeenCalled();
    expect(data.cancelled).toBe(0);
  });

  it("a connections prefetch read error fails the run loud (no silent empty-set pass)", async () => {
    state.connectionsReadError = { message: "connection reset" };

    await expect(POST(req)).rejects.toThrow(/Gmail connections prefetch failed/);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    expect(state.updates.some((u) => u.patch.status === "cancelled_reply")).toBe(false);
  });
});

describe("send-follow-ups cron — claim lifecycle + fail-loud (CAR-139)", () => {
  // A sweep write targeting stale 'sending' rows re-asserts the sending guard.
  const sweepWrite = (statusVal: string) =>
    state.updates.find(
      (u) =>
        u.patch.status === statusVal &&
        u.filters.some((f) => f[0] === "eq" && f[1] === "status" && f[2] === "sending"),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    state.pendingMessages = [];
    state.connections = [];
    state.activeUserIds = [];
    state.updates = [];
    state.claimCount = 1;
    state.staleRows = [];
    state.sweepReadError = null;
    state.dueReadError = null;
    state.connectionsReadError = null;
    getGmailClientSpy.mockReset();
  });

  it("parks stale 'sending' rows under an ACTIVE parent as awaiting_review with the full stamp", async () => {
    state.staleRows = [
      { id: 501, email_follow_ups: { status: "active" } },
      { id: 502, email_follow_ups: { status: "active" } },
    ];

    const res = await POST(req);
    const data = await res.json();

    const park = sweepWrite("awaiting_review");
    expect(park).toBeDefined();
    expect(park!.table).toBe("email_follow_up_messages");
    expect(park!.patch).toMatchObject({
      status: "awaiting_review",
      reminder_count: 0,
      last_reminder_at: null,
      seen_during_window: false,
      claimed_at: null,
    });
    // The parking stamp anchors the CAR-105 countdown/expiry/nudge machinery.
    expect(typeof park!.patch.parked_at).toBe("string");
    expect(typeof park!.patch.expires_at).toBe("string");
    // Targets exactly the stale ids under an active parent.
    expect(park!.filters).toContainEqual(["in", "id", [501, 502]]);
    // The swept row is user-resolvable, never auto-resent: no send happened.
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    expect(data.processed).toBe(0);
  });

  it("cancels stale 'sending' rows whose parent is no longer active (no invisible orphan)", async () => {
    state.staleRows = [
      { id: 601, email_follow_ups: { status: "cancelled_reply" } },
      { id: 602, email_follow_ups: { status: "completed" } },
    ];

    const res = await POST(req);
    await res.json();

    const cancel = sweepWrite("cancelled");
    expect(cancel).toBeDefined();
    expect(cancel!.patch).toEqual({ status: "cancelled", claimed_at: null });
    expect(cancel!.filters).toContainEqual(["in", "id", [601, 602]]);
    // Dead-parent rows are NOT parked as awaiting_review (that would strand them
    // behind the parent-active-gated surfaces as invisible orphans).
    expect(state.updates.some((u) => u.patch.status === "awaiting_review")).toBe(false);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("partitions a mixed stale batch: active parents parked, dead parents cancelled", async () => {
    state.staleRows = [
      { id: 701, email_follow_ups: { status: "active" } },
      { id: 702, email_follow_ups: { status: "cancelled_user" } },
    ];

    await (await POST(req)).json();

    expect(sweepWrite("awaiting_review")!.filters).toContainEqual(["in", "id", [701]]);
    expect(sweepWrite("cancelled")!.filters).toContainEqual(["in", "id", [702]]);
  });

  it("a sweep read error fails the cron run (fail-loud, before any send)", async () => {
    state.sweepReadError = { message: "connection reset" };
    await expect(POST(req)).rejects.toThrow(/Stale-claim sweep read failed/);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("claim stamps claimed_at; a send failure reverts to pending and clears it", async () => {
    getGmailClientSpy.mockResolvedValue({
      users: { threads: { get: async () => ({ data: { messages: [{ payload: { headers: [] } }] } }) } },
    });
    sendTrackedEmailSpy.mockRejectedValueOnce(new Error("gmail 500"));
    // Recently due (inside the 3-day window) so the failure path reverts to
    // pending instead of cancelling.
    state.pendingMessages = [
      { ...dueMessage("prem-1"), scheduled_send_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    ];
    state.connections = [
      { user_id: "prem-1", gmail_address: "prem@x.com", modify_scope_granted: true, automatic_features_enabled: true, premium_enabled: true },
    ];
    state.activeUserIds = ["prem-1"];

    const res = await POST(req);
    await res.json();

    const claim = state.updates.find((u) => u.patch.status === "sending");
    expect(claim).toBeDefined();
    expect(typeof claim!.patch.claimed_at).toBe("string");
    const revert = state.updates.find((u) => u.patch.status === "pending");
    expect(revert).toBeDefined();
    expect(revert!.patch.claimed_at).toBeNull();
  });

  it("a due-query read error fails the cron run (no success payload)", async () => {
    // withCronGuard is mocked as a passthrough here, so the fail-loud throw
    // surfaces as a rejection. In production the real guard converts it to a
    // 500 + api_error guardrail event — never a healthy {processed: 0}.
    state.dueReadError = { message: "connection reset" };

    await expect(POST(req)).rejects.toThrow(/Due follow-up query failed/);
  });
});

describe("send-follow-ups cron — aged send failures only cancel on a policy verdict", () => {
  // sendTrackedEmail throws for two very different reasons, and the aged-message
  // branch used to conflate them: a POLICY refusal (SendPolicyError) is a verdict
  // about the recipient, while an INFRASTRUCTURE failure (the daily-cap count's
  // PostgrestError, the provenance read's must() throw, a Gmail 5xx) says nothing
  // about whether the message should ever be sent. 'cancelled' is terminal, so
  // only the former may reach it.
  const aged = () => new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const messageWrite = (statusVal: string) =>
    state.updates.find((u) => u.table === "email_follow_up_messages" && u.patch.status === statusVal);

  beforeEach(() => {
    vi.clearAllMocks();
    state.pendingMessages = [{ ...dueMessage("prem-1"), scheduled_send_at: aged() }];
    state.connections = [
      { user_id: "prem-1", gmail_address: "prem@x.com", modify_scope_granted: true, automatic_features_enabled: true, premium_enabled: true },
    ];
    state.activeUserIds = ["prem-1"];
    state.updates = [];
    state.claimCount = 1;
    state.staleRows = [];
    state.sweepReadError = null;
    state.dueReadError = null;
    state.connectionsReadError = null;
    getGmailClientSpy.mockReset();
    getGmailClientSpy.mockResolvedValue({
      users: { threads: { get: async () => ({ data: { messages: [{ payload: { headers: [] } }] } }) } },
    });
  });

  it("a transient DB error on an AGED message reverts to pending, never cancels", async () => {
    // Shaped like the PostgrestError sendTrackedEmail rethrows from the daily-cap
    // count (not an Error instance, exactly as supabase-js surfaces it).
    sendTrackedEmailSpy.mockRejectedValueOnce({
      code: "57014",
      message: "canceling statement due to statement timeout",
      details: null,
      hint: null,
    });

    const res = await POST(req);
    const data = await res.json();

    const revert = messageWrite("pending");
    expect(revert).toBeDefined();
    expect(revert!.patch.claimed_at).toBeNull();
    expect(messageWrite("cancelled")).toBeUndefined();
    expect(data.cancelled).toBe(0);
  });

  it("a must() throw from the provenance read on an AGED message reverts to pending", async () => {
    sendTrackedEmailSpy.mockRejectedValueOnce(new Error("contact_emails read failed"));

    const res = await POST(req);
    await res.json();

    expect(messageWrite("pending")).toBeDefined();
    expect(messageWrite("cancelled")).toBeUndefined();
  });

  it("a bounced-recipient refusal (SendPolicyError 422) on an AGED message still cancels", async () => {
    sendTrackedEmailSpy.mockRejectedValueOnce(
      new SendPolicyError("amy@y.com has bounced before", 422),
    );

    const res = await POST(req);
    const data = await res.json();

    const cancel = messageWrite("cancelled");
    expect(cancel).toBeDefined();
    expect(cancel!.patch).toEqual({ status: "cancelled", claimed_at: null });
    expect(messageWrite("pending")).toBeUndefined();
    expect(data.sent).toBe(0);
  });

  it("the daily cap (SendPolicyError 429) on an AGED message reverts to pending, never cancels", async () => {
    sendTrackedEmailSpy.mockRejectedValueOnce(
      new SendPolicyError("Daily send limit reached (50).", 429),
    );

    const res = await POST(req);
    await res.json();

    expect(messageWrite("pending")).toBeDefined();
    expect(messageWrite("cancelled")).toBeUndefined();
  });
});
