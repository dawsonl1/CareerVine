import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * CAR-220: the follow-up sequence's anti-burst guard, and which driver drove.
 *
 * The guard used to be "send at most one message per sequence per TICK", which
 * is a rate limit denominated in ticks. Its comment claimed the property it was
 * really after — steps in a sequence go out spaced apart, never as a burst of
 * cold emails seconds apart. Those two agreed only while a tick was 10 minutes.
 * CAR-215 made the driver a watcher polling every ~15 seconds, and the same
 * `break` then let three due steps go to the same person 15 seconds apart, from
 * the user's own Gmail, against their own domain reputation.
 *
 * So the spacing is asserted in wall-clock time here, across runs, with the
 * clock moved between them — a per-tick guard passes the single-run cases and
 * fails the moment the ticks speed up, which is exactly the regression.
 */

const getGmailClientSpy = vi.fn();
const sendTrackedEmailSpy = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const recordDriverBeatSpy = vi.fn<(service: unknown, name: string) => Promise<void>>(async () => {});

const state: {
  pendingMessages: unknown[];
  connections: unknown[];
  activeUserIds: string[];
  updates: { table: string; patch: Record<string, unknown>; filters: Array<[string, ...unknown[]]> }[];
  claimCount: number;
  /** Latest `sent_at` per sequence, i.e. what the DB would return. */
  lastSentAt: Record<number, string>;
  /** error injected into the recent-send spacing read. */
  spacingReadError: { message: string } | null;
} = {
  pendingMessages: [],
  connections: [],
  activeUserIds: [],
  updates: [],
  claimCount: 1,
  lastSentAt: {},
  spacingReadError: null,
};

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

vi.mock("@/lib/gmail", () => ({
  activateContactByEmail: async () => {},
}));

vi.mock("@/lib/email-send", () => ({
  sendTrackedEmail: (...a: unknown[]) => sendTrackedEmailSpy(...a),
  SendPolicyError: class SendPolicyError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "SendPolicyError";
      this.status = status;
    }
  },
}));

vi.mock("@/lib/watcher-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/watcher-health")>();
  return {
    ...actual,
    recordDriverBeat: (service: unknown, name: string) => recordDriverBeatSpy(service, name),
  };
});

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
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
        gt: (col: string, val: unknown) => { filters.push(["gt", col, val]); return b; },
        not: () => b,
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => void) => {
          const hasEq = (c: string, v: unknown) => filters.some((f) => f[0] === "eq" && f[1] === c && f[2] === v);
          const hasLt = (c: string) => filters.some((f) => f[0] === "lt" && f[1] === c);
          const gtValue = (c: string) =>
            filters.find((f) => f[0] === "gt" && f[1] === c)?.[2] as string | undefined;
          if (mode === "update") return resolve({ error: null, count: isCount ? state.claimCount : null });
          if (isCount) return resolve({ count: 0 });
          if (table === "email_follow_up_messages") {
            // Stale-claim sweep SELECT.
            if (hasEq("status", "sending") && hasLt("claimed_at")) return resolve({ data: [], error: null });
            // Spacing read: sequences with a message sent since the cutoff.
            const cutoff = gtValue("sent_at");
            if (hasEq("status", "sent") && cutoff !== undefined) {
              if (state.spacingReadError) return resolve({ data: null, error: state.spacingReadError });
              const rows = Object.entries(state.lastSentAt)
                .filter(([, at]) => at > cutoff)
                .map(([id]) => ({ follow_up_id: Number(id) }));
              return resolve({ data: rows, error: null });
            }
            return resolve({ data: state.pendingMessages, error: null });
          }
          if (table === "gmail_connections") return resolve({ data: state.connections, error: null });
          return resolve({ data: [] });
        },
      };
      return b;
    },
  })),
);

import { mockServiceClientModule } from "./helpers/mock-supabase";
import { POST } from "@/app/api/cron/send-follow-ups/route";
import { SEND_WATCHER, QSTASH_SAFETY_NET } from "@/lib/watcher-health";

function dueMessage(id: number, seqId: number, scheduledSendAt: string) {
  return {
    id,
    follow_up_id: seqId,
    subject: `Step ${id}`,
    body_html: "<p>hi</p>",
    scheduled_send_at: scheduledSendAt,
    email_follow_ups: {
      id: seqId,
      user_id: "prem-1",
      thread_id: `t-${seqId}`,
      recipient_email: `amy${seqId}@y.com`,
      contact_name: "Amy",
      original_gmail_message_id: `gmid-${seqId}`,
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

const premiumConnection = {
  user_id: "prem-1",
  gmail_address: "prem@x.com",
  modify_scope_granted: true,
  automatic_features_enabled: true,
  premium_enabled: true,
};

/** The `sent_at` the route just wrote, i.e. what the DB now holds. */
function lastSentStamp(): string {
  const write = [...state.updates].reverse().find((u) => u.patch.status === "sent");
  return write!.patch.sent_at as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.pendingMessages = [];
  state.connections = [premiumConnection];
  state.activeUserIds = ["prem-1"];
  state.updates = [];
  state.claimCount = 1;
  state.lastSentAt = {};
  state.spacingReadError = null;
  getGmailClientSpy.mockReset();
  getGmailClientSpy.mockResolvedValue({
    users: { threads: { get: async () => ({ data: { messages: [{ payload: { headers: [] } }] } }) } },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("send-follow-ups cron — deliverability spacing is measured in time, not ticks", () => {
  it("does NOT send a second step 15s after the first, then does once the spacing has elapsed", async () => {
    // The CAR-215 regression in full. Two steps of one sequence fall due
    // together (watcher downtime, reactivation, automation re-enabled), and the
    // watcher pokes this route every ~15 seconds.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"));
    const overdue = "2026-08-01T09:00:00.000Z";
    state.pendingMessages = [dueMessage(100, 1, overdue), dueMessage(101, 1, overdue)];

    // Tick 1: one step goes out.
    await (await POST(req)).json();
    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    state.lastSentAt[1] = lastSentStamp();
    state.pendingMessages = [dueMessage(101, 1, overdue)];

    // Tick 2, fifteen seconds later. Per-tick, this is a brand new tick and the
    // `break` has no memory of the last one: the second cold email goes to the
    // same person 15 seconds after the first.
    vi.setSystemTime(new Date("2026-08-04T10:00:15.000Z"));
    state.updates = [];
    const res2 = await (await POST(req)).json();
    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(state.updates.some((u) => u.patch.status === "sending")).toBe(false);
    expect(res2.spaced).toBe(1);

    // And the step is held, not dropped: once the spacing has elapsed it sends.
    vi.setSystemTime(new Date("2026-08-04T10:30:00.000Z"));
    state.updates = [];
    await (await POST(req)).json();
    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(2);
    expect(state.updates.some((u) => u.patch.status === "sent")).toBe(true);
  });

  it("still sends the first step of a sequence that has never sent anything", async () => {
    // The guard must not be a blanket delay: a sequence with no prior send has
    // nothing to be spaced from and goes out at the resolution CAR-215 bought.
    state.pendingMessages = [dueMessage(100, 1, "2026-08-01T09:00:00.000Z")];

    const res = await (await POST(req)).json();

    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(1);
    expect(res.spaced).toBe(0);
  });

  it("spaces per sequence, never across sequences", async () => {
    // Two different people. One of them having just been emailed says nothing
    // about the other, and a guard that stalled the whole queue would turn a
    // deliverability rule into a delivery outage.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"));
    state.pendingMessages = [
      dueMessage(100, 1, "2026-08-01T09:00:00.000Z"),
      dueMessage(200, 2, "2026-08-01T09:00:00.000Z"),
    ];
    state.lastSentAt[1] = "2026-08-04T09:58:00.000Z"; // seq 1 sent 2 minutes ago

    const res = await (await POST(req)).json();

    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendTrackedEmailSpy).toHaveBeenCalledWith(
      "prem-1",
      expect.objectContaining({ to: "amy2@y.com" }),
      { isFollowUp: true },
    );
    expect(res.spaced).toBe(1);
    expect(res.sent).toBe(1);
  });

  it("holds a sequence whose last message went out inside the spacing window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T10:00:00.000Z"));
    state.pendingMessages = [dueMessage(101, 1, "2026-08-01T09:00:00.000Z")];
    state.lastSentAt[1] = "2026-08-04T09:59:00.000Z"; // one minute ago

    const res = await (await POST(req)).json();

    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
    // Held, never resolved: no claim, no status write of any kind on the row.
    expect(state.updates.filter((u) => u.table === "email_follow_up_messages")).toEqual([]);
    expect(res.spaced).toBe(1);
  });

  it("fails the run loud when the spacing read errors, rather than bursting", async () => {
    // An unreadable spacing table means the burst cannot be ruled out. The other
    // reads on this route already fail loud for the same reason; a silent empty
    // result here would send every due step of every sequence in one pass.
    state.pendingMessages = [dueMessage(100, 1, "2026-08-01T09:00:00.000Z")];
    state.spacingReadError = { message: "connection reset" };

    await expect(POST(req)).rejects.toThrow(/spacing/i);
    expect(sendTrackedEmailSpy).not.toHaveBeenCalled();
  });

  it("still sends only one step per sequence within a single run", async () => {
    // The in-run half of the guard. Time-based spacing cannot see a send that
    // has not been written yet, so the `break` still has to hold inside a run.
    state.pendingMessages = [
      dueMessage(100, 1, "2026-08-01T09:00:00.000Z"),
      dueMessage(101, 1, "2026-08-01T09:30:00.000Z"),
    ];

    const res = await (await POST(req)).json();

    expect(sendTrackedEmailSpy).toHaveBeenCalledTimes(1);
    expect(res.sent).toBe(1);
  });
});

describe("send-follow-ups cron — driver liveness (CAR-220)", () => {
  it("stamps the QStash safety net's own row when QStash drove the run", async () => {
    // Only `send-watcher` was ever stamped, so the module's claim that the two
    // drivers watch each other was half a claim: a paused QStash schedule left
    // no trace anywhere. Nothing reads this row yet — stamping it is what makes
    // the reader buildable.
    await (await POST(req)).json();

    expect(recordDriverBeatSpy).toHaveBeenCalledTimes(1);
    expect(recordDriverBeatSpy.mock.calls[0][1]).toBe(QSTASH_SAFETY_NET);
  });

  it("stamps the watcher's row when the watcher drove the run", async () => {
    process.env.CRON_TRIGGER_SECRET = "watcher-secret";
    const watcherReq = {
      text: async () => "",
      headers: { get: (h: string) => (h.toLowerCase() === "authorization" ? "Bearer watcher-secret" : "") },
      url: "http://localhost:3000/api/cron/send-follow-ups",
    } as never;

    try {
      await (await POST(watcherReq)).json();

      expect(recordDriverBeatSpy).toHaveBeenCalledTimes(1);
      expect(recordDriverBeatSpy.mock.calls[0][1]).toBe(SEND_WATCHER);
    } finally {
      delete process.env.CRON_TRIGGER_SECRET;
    }
  });
});
