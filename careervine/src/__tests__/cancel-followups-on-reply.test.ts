import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CAR-233: a follow-up sequence dies as soon as CareerVine SEES the reply, not
 * when its next step happens to come due.
 *
 * Two halves, both pinned here:
 *   1. `cancelFollowUpsForRepliedThreads` — the single implementation the sync
 *      path, the send cron, and the free-tier manual mark all share. Its edge
 *      cases are the ones a fourth hand-rolled copy would drop: never stomp a
 *      'sending' claim, sweep 'expired' as well as 'pending', stay inside the
 *      user, and stay batched (the sync loop calls it per contact).
 *   2. The sync path end-to-end through the REAL `syncEmailsForContact` loop,
 *      because "the app cancels when it sees a reply" is a claim about the
 *      wiring, not about the helper in isolation.
 */

let db = createFakeSyncDb();
let fake = createFakeGmail();

vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: async () => fake.gmail,
  getConnection: async () => (db.tables.gmail_connections ?? [])[0] ?? null,
  buildMimeMessage: () => "",
  sendEmail: async () => ({ messageId: "m", threadId: "t" }),
}));

vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule(() => db.client));

vi.mock("@/lib/analytics/server", () =>
  mockAnalyticsServerModule({
    trackServer: async () => {},
    checkCompaniesEmailedMilestone: async () => {},
  }),
);

import { cancelFollowUpsForRepliedThreads } from "@/lib/follow-up-helpers";
import { syncEmailsForContact } from "@/lib/gmail";

const USER = "user-1";
const OTHER_USER = "user-2";
const CONTACT = 7;
const THREAD = "t1";

/** Client cast: the fake models the builder chain the helper actually uses. */
const client = () => db.client as unknown as SupabaseClient;

/** One active sequence on THREAD with a step in each unresolved state. */
function seedSequence(
  overrides: {
    followUps?: Record<string, unknown>[];
    messages?: Record<string, unknown>[];
  } = {},
) {
  db = createFakeSyncDb({
    contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "prospect" }],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    email_messages: [],
    email_follow_ups: overrides.followUps ?? [
      { id: 1, user_id: USER, thread_id: THREAD, status: "active", recipient_email: "jane@corp.com" },
    ],
    email_follow_up_messages: overrides.messages ?? [
      { id: 10, follow_up_id: 1, status: "pending" },
      { id: 11, follow_up_id: 1, status: "awaiting_review" },
      { id: 12, follow_up_id: 1, status: "expired" },
    ],
  });
}

beforeEach(() => {
  seedSequence();
  fake = createFakeGmail();
});

describe("cancelFollowUpsForRepliedThreads", () => {
  it("cancels the parent as cancelled_reply and every unresolved step", async () => {
    const cancelled = await cancelFollowUpsForRepliedThreads(client(), USER, [THREAD]);

    expect(cancelled).toBe(1);
    expect(db.tables.email_follow_ups[0].status).toBe("cancelled_reply");
    expect(db.tables.email_follow_ups[0].updated_at).toBeTruthy();
    // pending, awaiting_review AND expired — an expired step is still one-click
    // sendable (CAR-105), so leaving it would orphan a sendable nag under a
    // cancelled parent.
    expect(db.tables.email_follow_up_messages.map((m) => m.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("never stomps a 'sending' claim a send driver already holds", async () => {
    seedSequence({
      messages: [
        { id: 10, follow_up_id: 1, status: "sending" },
        { id: 11, follow_up_id: 1, status: "pending" },
      ],
    });

    await cancelFollowUpsForRepliedThreads(client(), USER, [THREAD]);

    // The claimed row is mid-Gmail-round-trip; the cron's stale-claim sweep owns
    // it. Cancelling it here would race a send that may already be out.
    const byId = Object.fromEntries(db.tables.email_follow_up_messages.map((m) => [m.id, m.status]));
    expect(byId[10]).toBe("sending");
    expect(byId[11]).toBe("cancelled");
  });

  it("leaves terminal steps and already-sent history untouched", async () => {
    seedSequence({
      messages: [
        { id: 10, follow_up_id: 1, status: "sent" },
        { id: 11, follow_up_id: 1, status: "failed" },
        { id: 12, follow_up_id: 1, status: "pending" },
      ],
    });

    await cancelFollowUpsForRepliedThreads(client(), USER, [THREAD]);

    const byId = Object.fromEntries(db.tables.email_follow_up_messages.map((m) => [m.id, m.status]));
    expect(byId[10]).toBe("sent");
    expect(byId[11]).toBe("failed");
    expect(byId[12]).toBe("cancelled");
  });

  it("does not rewrite a sequence that is not active", async () => {
    seedSequence({
      followUps: [
        { id: 1, user_id: USER, thread_id: THREAD, status: "completed" },
        { id: 2, user_id: USER, thread_id: THREAD, status: "cancelled_user" },
      ],
      messages: [],
    });

    const cancelled = await cancelFollowUpsForRepliedThreads(client(), USER, [THREAD]);

    expect(cancelled).toBe(0);
    expect(db.tables.email_follow_ups.map((f) => f.status)).toEqual(["completed", "cancelled_user"]);
  });

  it("stays inside the user, even though the thread id matches", async () => {
    seedSequence({
      followUps: [
        { id: 1, user_id: OTHER_USER, thread_id: THREAD, status: "active" },
      ],
      messages: [{ id: 10, follow_up_id: 1, status: "pending" }],
    });

    const cancelled = await cancelFollowUpsForRepliedThreads(client(), USER, [THREAD]);

    expect(cancelled).toBe(0);
    expect(db.tables.email_follow_ups[0].status).toBe("active");
    expect(db.tables.email_follow_up_messages[0].status).toBe("pending");
  });

  it("leaves sequences on other threads alone", async () => {
    seedSequence({
      followUps: [
        { id: 1, user_id: USER, thread_id: THREAD, status: "active" },
        { id: 2, user_id: USER, thread_id: "t-other", status: "active" },
      ],
      messages: [
        { id: 10, follow_up_id: 1, status: "pending" },
        { id: 20, follow_up_id: 2, status: "pending" },
      ],
    });

    await cancelFollowUpsForRepliedThreads(client(), USER, [THREAD]);

    const fu = Object.fromEntries(db.tables.email_follow_ups.map((f) => [f.id, f.status]));
    expect(fu[1]).toBe("cancelled_reply");
    expect(fu[2]).toBe("active");
    const msgs = Object.fromEntries(db.tables.email_follow_up_messages.map((m) => [m.id, m.status]));
    expect(msgs[20]).toBe("pending");
  });

  it("issues no query at all for an empty or all-null thread set", async () => {
    const before = db.ops.length;

    expect(await cancelFollowUpsForRepliedThreads(client(), USER, [])).toBe(0);
    expect(await cancelFollowUpsForRepliedThreads(client(), USER, [null, undefined, ""])).toBe(0);

    // The load-cost claim in the plan rests on this: a sync that ingested no
    // reply must not pay for a lookup.
    expect(db.ops.length).toBe(before);
  });

  it("stays batched — many threads cost one read and two writes, not N", async () => {
    seedSequence({
      followUps: [
        { id: 1, user_id: USER, thread_id: "t1", status: "active" },
        { id: 2, user_id: USER, thread_id: "t2", status: "active" },
        { id: 3, user_id: USER, thread_id: "t3", status: "active" },
      ],
      messages: [
        { id: 10, follow_up_id: 1, status: "pending" },
        { id: 20, follow_up_id: 2, status: "pending" },
        { id: 30, follow_up_id: 3, status: "pending" },
      ],
    });
    const before = db.ops.length;

    // Duplicates collapse too — the sync path feeds this one entry per inbound
    // message, and a thread can carry several.
    const cancelled = await cancelFollowUpsForRepliedThreads(client(), USER, [
      "t1", "t2", "t3", "t1", "t2",
    ]);

    expect(cancelled).toBe(3);
    expect(db.ops.length - before).toBe(3);
    expect(db.tables.email_follow_ups.every((f) => f.status === "cancelled_reply")).toBe(true);
  });

  it("throws on a read failure rather than reporting nothing to cancel", async () => {
    db = createFakeSyncDb(
      {
        email_follow_ups: [{ id: 1, user_id: USER, thread_id: THREAD, status: "active" }],
        email_follow_up_messages: [{ id: 10, follow_up_id: 1, status: "pending" }],
      },
      { failOn: (table, op) => (table === "email_follow_ups" && op === "select" ? "boom" : null) },
    );

    // A swallowed read error reads as "no active sequences", which sends the
    // very nag this function exists to stop.
    await expect(cancelFollowUpsForRepliedThreads(client(), USER, [THREAD])).rejects.toThrow();
    expect(db.tables.email_follow_up_messages[0].status).toBe("pending");
  });
});

describe("syncEmailsForContact — reply cancels the sequence on sight (CAR-233)", () => {
  it("cancels the thread's active sequence as soon as the reply is ingested", async () => {
    fake = createFakeGmail({
      pages: [[
        {
          id: "m-reply",
          threadId: THREAD,
          from: "Jane <jane@corp.com>",
          to: "me@gmail.com",
          subject: "re",
          date: "Mon, 13 Jul 2026 12:00:00 -0600",
        },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(db.tables.email_follow_ups[0].status).toBe("cancelled_reply");
    expect(db.tables.email_follow_up_messages.every((m) => m.status === "cancelled")).toBe(true);
    // The pre-existing reply behavior still holds.
    expect(db.tables.contacts[0].network_status).toBe("active");
  });

  it("does not cancel on our own outbound mail, including from a send-as alias", async () => {
    fake = createFakeGmail({
      pages: [[
        { id: "m-out", threadId: THREAD, from: "me@gmail.com", to: "jane@corp.com", subject: "hi", date: "Mon, 13 Jul 2026 10:00:00 -0600" },
        { id: "m-alias", threadId: THREAD, from: "Me <me@myalias.dev>", to: "jane@corp.com", subject: "bump", date: "Mon, 13 Jul 2026 11:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com", "me@myalias.dev"]);

    expect(db.tables.email_follow_ups[0].status).toBe("active");
    expect(db.tables.email_follow_up_messages.map((m) => m.status)).toEqual([
      "pending",
      "awaiting_review",
      "expired",
    ]);
  });

  it("does not treat a bounce notification as a reply", async () => {
    fake = createFakeGmail({
      pages: [[
        {
          id: "m-ndr",
          threadId: THREAD,
          from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          to: "me@gmail.com",
          subject: "Delivery Status Notification (Failure)",
          date: "Mon, 13 Jul 2026 12:00:00 -0600",
        },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    // detectBounces owns NDRs (cancelled_bounce). Cancelling as "replied" here
    // would also graduate the contact whose address just failed.
    expect(db.tables.email_follow_ups[0].status).toBe("active");
    expect(db.tables.contacts[0].network_status).toBe("prospect");
  });

  it("does not query for sequences when the sync ingested no reply", async () => {
    fake = createFakeGmail({
      pages: [[
        { id: "m-out", threadId: THREAD, from: "me@gmail.com", to: "jane@corp.com", subject: "hi", date: "Mon, 13 Jul 2026 10:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(db.opsFor("email_follow_ups")).toHaveLength(0);
  });
});
