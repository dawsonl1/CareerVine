import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-105 nudge cron state machine. Uses a faithful in-memory table engine (not
 * a canned then() stub) so the two load-bearing mechanics are exercised for
 * real: the atomic claim's COUNT reflects the actual WHERE match (rule-17 safe),
 * and every .eq/.lt/.lte filter is applied to real rows. That's the only way to
 * prove claim idempotency, milestone skipping, and the grace set-once guard.
 */

const sendAppEmailSpy = vi.fn(async () => ({ ok: true, id: "e1" }));

vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify() {
      return Promise.resolve(true);
    }
  },
}));
vi.mock("@/lib/cron-guard", () => ({
  withCronGuard: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/notify/email", () => ({
  sendAppEmail: (...a: unknown[]) => sendAppEmailSpy(...a),
}));
vi.mock("@/lib/notify/tokens", () => ({
  signUnsubscribeToken: (uid: string) => `${uid}.tok`,
}));
vi.mock("@/lib/analytics/server", () => ({
  trackServer: async () => {},
}));

// ── In-memory table engine ───────────────────────────────────────────────
type Row = Record<string, unknown>;
const store: { email_follow_up_messages: Row[]; users: Row[] } = {
  email_follow_up_messages: [],
  users: [],
};

function getPath(row: Row, col: string): unknown {
  return col.split(".").reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Row)[k]), row);
}
type Filter = { op: "eq" | "lt" | "lte" | "in"; col: string; val: unknown };
function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = getPath(row, f.col);
    if (f.op === "eq") return v === f.val;
    if (f.op === "lt") return (v as number | string) < (f.val as number | string);
    if (f.op === "lte") return (v as number | string) <= (f.val as number | string);
    if (f.op === "in") return (f.val as unknown[]).includes(v);
    return false;
  });
}

function makeClient() {
  return {
    from: (table: keyof typeof store) => {
      let mode: "read" | "update" = "read";
      let patch: Row = {};
      let countReq = false;
      const filters: Filter[] = [];
      const qb: Record<string, unknown> = {
        select: (_s: string, opts?: { count?: string }) => {
          if (opts?.count) countReq = true;
          return qb;
        },
        update: (p: Row, opts?: { count?: string }) => {
          mode = "update";
          patch = p;
          if (opts?.count) countReq = true;
          return qb;
        },
        eq: (col: string, val: unknown) => (filters.push({ op: "eq", col, val }), qb),
        lt: (col: string, val: unknown) => (filters.push({ op: "lt", col, val }), qb),
        lte: (col: string, val: unknown) => (filters.push({ op: "lte", col, val }), qb),
        in: (col: string, val: unknown[]) => (filters.push({ op: "in", col, val }), qb),
        order: () => qb,
        limit: () => qb,
        then: (resolve: (v: unknown) => void) => {
          const matched = store[table].filter((r) => matches(r, filters));
          if (mode === "update") {
            for (const r of matched) Object.assign(r, patch);
            return resolve({ data: null, error: null, count: countReq ? matched.length : null });
          }
          return resolve({ data: matched, error: null, count: countReq ? matched.length : null });
        },
      };
      return qb;
    },
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { email: `${id}@example.com` } },
        }),
      },
    },
  };
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => makeClient(),
}));

import { POST } from "@/app/api/cron/follow-up-nudges/route";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-12T09:00:00.000Z");

const req = {
  text: async () => "",
  headers: { get: () => "" },
  url: "http://localhost:3000/api/cron/follow-up-nudges",
} as never;

function msg(over: Partial<Row> & { parked_at: string }): Row {
  return {
    id: Math.floor(Math.random() * 1e9),
    follow_up_id: 1,
    subject: "Following up",
    expires_at: new Date(Date.parse(over.parked_at) + 14 * DAY).toISOString(),
    reminder_count: 0,
    seen_during_window: false,
    status: "awaiting_review",
    email_follow_ups: {
      user_id: "u1",
      contact_name: "Amy",
      recipient_email: "amy@y.com",
      status: "active",
    },
    ...over,
  };
}

function user(over: Partial<Row> = {}): Row {
  return { id: "u1", status: "active", web_last_seen_at: null, followup_nudges_enabled: true, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.email_follow_up_messages = [];
  store.users = [];
});

describe("CAR-105 nudge cron — cadence", () => {
  it("day 0: a just-parked item is claimed and one digest goes out", async () => {
    const m = msg({ parked_at: new Date(NOW).toISOString(), reminder_count: 0 });
    store.email_follow_up_messages = [m];
    store.users = [user()];

    const res = await POST(req);
    const data = await res.json();

    expect(sendAppEmailSpy).toHaveBeenCalledTimes(1);
    expect(m.reminder_count).toBe(1);
    expect(data.nudged).toBe(1);
  });

  it("skips missed milestones: parked 10d ago, count=1 jumps straight to 3 (day 9), not 2", async () => {
    const m = msg({ parked_at: new Date(NOW - 10 * DAY).toISOString(), reminder_count: 1 });
    store.email_follow_up_messages = [m];
    store.users = [user()];

    await POST(req);

    expect(sendAppEmailSpy).toHaveBeenCalledTimes(1);
    expect(m.reminder_count).toBe(3);
  });

  it("idempotent: an already-sent milestone is not re-sent (count === target)", async () => {
    // Parked today, day-0 already sent (reminder_count already 1). target=1, so
    // reminder_count < target is false -> no claim, no email (a QStash retry).
    const m = msg({ parked_at: new Date(NOW).toISOString(), reminder_count: 1 });
    store.email_follow_up_messages = [m];
    store.users = [user()];

    await POST(req);

    expect(sendAppEmailSpy).not.toHaveBeenCalled();
    expect(m.reminder_count).toBe(1);
  });

  it("digest batching: two due items for one user collapse into ONE email", async () => {
    const a = msg({ id: 1, parked_at: new Date(NOW).toISOString(), subject: "A" });
    const b = msg({ id: 2, follow_up_id: 2, parked_at: new Date(NOW).toISOString(), subject: "B" });
    store.email_follow_up_messages = [a, b];
    store.users = [user()];

    await POST(req);

    expect(sendAppEmailSpy).toHaveBeenCalledTimes(1);
    // The digest carried both items.
    const items = (sendAppEmailSpy.mock.calls[0][0] as { html: string }).html;
    expect(items).toContain("A");
    expect(items).toContain("B");
  });

  it("opt-out suppresses the email even when a milestone is due", async () => {
    const m = msg({ parked_at: new Date(NOW).toISOString(), reminder_count: 0 });
    store.email_follow_up_messages = [m];
    store.users = [user({ followup_nudges_enabled: false })];

    await POST(req);

    expect(sendAppEmailSpy).not.toHaveBeenCalled();
    expect(m.reminder_count).toBe(0);
  });

  it("no email at or after the 14-day window edge", async () => {
    const m = msg({ parked_at: new Date(NOW - 15 * DAY).toISOString(), reminder_count: 1 });
    store.email_follow_up_messages = [m];
    store.users = [user({ web_last_seen_at: new Date(NOW - DAY).toISOString() })];

    await POST(req);

    expect(sendAppEmailSpy).not.toHaveBeenCalled();
  });

  it("suspended account is frozen: no nudge", async () => {
    const m = msg({ parked_at: new Date(NOW).toISOString(), reminder_count: 0 });
    store.email_follow_up_messages = [m];
    store.users = [user({ status: "suspended" })];

    await POST(req);

    expect(sendAppEmailSpy).not.toHaveBeenCalled();
    expect(m.reminder_count).toBe(0);
  });
});

describe("CAR-105 nudge cron — active-aware expiry", () => {
  it("marks seen_during_window when the user was active in-app during the window", async () => {
    const m = msg({ parked_at: new Date(NOW - 2 * DAY).toISOString(), reminder_count: 3 });
    store.email_follow_up_messages = [m];
    // Active yesterday (after parking, inside the window).
    store.users = [user({ web_last_seen_at: new Date(NOW - DAY).toISOString() })];

    await POST(req);

    expect(m.seen_during_window).toBe(true);
    expect(m.status).toBe("awaiting_review"); // still inside window, not expired
  });

  it("expires at P+14d when the user was seen during the window", async () => {
    const m = msg({
      parked_at: new Date(NOW - 15 * DAY).toISOString(),
      reminder_count: 3,
      seen_during_window: true,
    });
    store.email_follow_up_messages = [m];
    store.users = [user({ web_last_seen_at: new Date(NOW - 15 * DAY + DAY).toISOString() })];

    const res = await POST(req);
    const data = await res.json();

    expect(m.status).toBe("expired");
    expect(data.expired).toBe(1);
  });

  it("never-return edge: past window, never active, never returned -> stays awaiting_review", async () => {
    const m = msg({
      parked_at: new Date(NOW - 20 * DAY).toISOString(),
      reminder_count: 3,
      seen_during_window: false,
    });
    store.email_follow_up_messages = [m];
    store.users = [user({ web_last_seen_at: null })];

    await POST(req);

    expect(m.status).toBe("awaiting_review");
  });

  it("grace: returns after the window -> expires_at set once to return+24h, not yet expired", async () => {
    const parked = new Date(NOW - 16 * DAY).toISOString();
    const windowEnd = Date.parse(parked) + 14 * DAY;
    const m = msg({
      parked_at: parked,
      reminder_count: 3,
      seen_during_window: false,
      expires_at: new Date(windowEnd).toISOString(),
    });
    store.email_follow_up_messages = [m];
    // Returned 1h ago (after the window); grace = return + 24h is still in the future.
    const returnedAt = NOW - 1 * 60 * 60 * 1000;
    store.users = [user({ web_last_seen_at: new Date(returnedAt).toISOString() })];

    await POST(req);

    expect(m.status).toBe("awaiting_review");
    expect(Date.parse(m.expires_at as string)).toBe(returnedAt + DAY);
  });

  it("grace elapsed: now past the granted (return+24h) deadline -> expired", async () => {
    const parked = new Date(NOW - 20 * DAY).toISOString();
    // Already-granted grace: expires_at sits well past P+14d and in the past now.
    const grantedExpiry = new Date(NOW - 60 * 60 * 1000).toISOString();
    const m = msg({
      parked_at: parked,
      reminder_count: 3,
      seen_during_window: false,
      expires_at: grantedExpiry,
    });
    store.email_follow_up_messages = [m];
    store.users = [user({ web_last_seen_at: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() })];

    await POST(req);

    expect(m.status).toBe("expired");
  });

  it("grace set-once: a daily-returning user does not push the deadline out again", async () => {
    // Past the window (parked 15d ago) but grace was already granted with a
    // still-future deadline, so the item is genuinely still waiting.
    const parked = new Date(NOW - 15 * DAY).toISOString();
    const windowEnd = Date.parse(parked) + 14 * DAY; // = NOW - 1 day
    const alreadyGranted = new Date(windowEnd + 3 * DAY).toISOString(); // = NOW + 2 days (future)
    const m = msg({
      parked_at: parked,
      reminder_count: 3,
      seen_during_window: false,
      expires_at: alreadyGranted,
    });
    store.email_follow_up_messages = [m];
    // User active again just now (return+24h = tomorrow, EARLIER than the granted
    // deadline — a re-grant would wrongly PULL expiry in; set-once must block it).
    store.users = [user({ web_last_seen_at: new Date(NOW).toISOString() })];

    await POST(req);

    // Deadline unchanged (set-once) and still waiting: the .lte guard blocked a re-grant.
    expect(m.expires_at).toBe(alreadyGranted);
    expect(m.status).toBe("awaiting_review");
  });
});
