import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";
import type { BounceAlertItem } from "@/lib/notify/bounce-alert";

/**
 * CAR-217. What detectBounces DOES once it has an address, as opposed to how it
 * finds one (that is bounce-parse.test.ts).
 *
 * Three of these cover behavior that did not exist before this ticket and whose
 * absence was silent: queued scheduled mail was never cancelled (the row simply
 * re-deferred on every cron tick, forever), the user was never told, and an NDR
 * without an X-Failed-Recipients header was dropped without a trace.
 */

const USER = "user-1";

let fake = createFakeGmail();
let db = createFakeSyncDb();
const alertCalls: { userId: string; items: BounceAlertItem[] }[] = [];

vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: async () => fake.gmail,
  getConnection: async () => (db.tables.gmail_connections ?? [])[0] ?? null,
  buildMimeMessage: () => "",
  sendEmail: async () => ({ messageId: "m", threadId: "t" }),
}));

vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule(() => db.client));

vi.mock("@/lib/analytics/server", () =>
  mockAnalyticsServerModule({ trackServer: async () => {}, checkCompaniesEmailedMilestone: async () => {} }),
);

vi.mock("@/lib/notify/send-bounce-alert", () => ({
  sendBounceAlert: async (userId: string, items: BounceAlertItem[]) => {
    alertCalls.push({ userId, items });
    return items.length > 0 ? "sent" : "no_items";
  },
}));

import { detectBounces } from "@/lib/gmail";

/** A Gmail-shaped NDR carrying the legacy header. */
const headerNdr = (id: string, address: string) => ({
  id,
  from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
  subject: "Delivery Status Notification (Failure)",
  extraHeaders: { "X-Failed-Recipients": address },
});

/** A Microsoft-shaped NDR: no header, an RFC 3464 report part instead. */
const reportNdr = (id: string, address: string) => ({
  id,
  from: "postmaster@corp.com",
  subject: "Undeliverable: Coffee chat",
  parts: [
    { mimeType: "text/plain", body: "Your message could not be delivered." },
    {
      mimeType: "message/delivery-status",
      body: `Reporting-MTA: dns; corp.com\n\nFinal-Recipient: rfc822; ${address}\nAction: failed\nStatus: 5.1.10\n`,
    },
  ],
});

function seed(overrides: Parameters<typeof createFakeSyncDb>[0] = {}) {
  return createFakeSyncDb({
    contacts: [{ id: 7, user_id: USER, name: "Dana Reed", network_status: "active" }],
    contact_emails: [
      {
        id: 1,
        contact_id: 7,
        email: "dana@corp.com",
        bounced_at: null,
        contacts: { user_id: USER, name: "Dana Reed" },
      },
    ],
    email_follow_ups: [],
    email_follow_up_messages: [],
    scheduled_emails: [],
    users: [{ id: USER, bounce_alerts_enabled: true }],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    ...overrides,
  });
}

beforeEach(() => {
  alertCalls.length = 0;
  fake = createFakeGmail({ pages: [[headerNdr("ndr-1", "dana@corp.com")]] });
  db = seed();
});

describe("detectBounces — queued scheduled mail", () => {
  it("cancels a PENDING scheduled email to the dead address", () => {
    // Before CAR-217 this row was never resolved: sendTrackedEmail refuses the
    // recipient with a 422 and processScheduledEmails defers, so the hourly cron
    // retried it indefinitely.
    db = seed({
      scheduled_emails: [
        { id: 11, user_id: USER, to_email: "dana@corp.com", status: "pending" },
      ],
    });

    return detectBounces(USER).then((result) => {
      expect(result.cancelledScheduled).toBe(1);
      expect(db.tables.scheduled_emails[0].status).toBe("cancelled");
    });
  });

  it("leaves a 'sending' row alone — that is a live claim, not queued work", async () => {
    // A send driver holds 'sending' for the length of one Gmail round trip. The
    // message may already be out, so stealing the claim risks contradicting a
    // delivered send; the stale-claim sweeper owns that row.
    db = seed({
      scheduled_emails: [
        { id: 12, user_id: USER, to_email: "dana@corp.com", status: "sending" },
      ],
    });

    const result = await detectBounces(USER);

    expect(result.cancelledScheduled).toBe(0);
    expect(db.tables.scheduled_emails[0].status).toBe("sending");
  });

  it("does not touch another user's scheduled mail to the same address", async () => {
    db = seed({
      scheduled_emails: [
        { id: 13, user_id: "someone-else", to_email: "dana@corp.com", status: "pending" },
      ],
    });

    const result = await detectBounces(USER);

    expect(result.cancelledScheduled).toBe(0);
    expect(db.tables.scheduled_emails[0].status).toBe("pending");
  });
});

describe("detectBounces — follow-up sequences", () => {
  it("retires the active sequence and its unresolved messages", async () => {
    db = seed({
      email_follow_ups: [
        { id: 21, user_id: USER, status: "active", recipient_email: "dana@corp.com" },
      ],
      email_follow_up_messages: [
        { id: 31, follow_up_id: 21, status: "pending" },
        { id: 32, follow_up_id: 21, status: "awaiting_review" },
        { id: 33, follow_up_id: 21, status: "sent" },
      ],
    });

    const result = await detectBounces(USER);

    expect(result.cancelledSequences).toBe(1);
    expect(db.tables.email_follow_ups[0].status).toBe("cancelled_bounce");
    expect(db.tables.email_follow_up_messages.map((m) => m.status)).toEqual([
      "cancelled",
      "cancelled",
      "sent", // already delivered — must not be rewritten
    ]);
  });
});

describe("detectBounces — notification", () => {
  it("alerts on the null -> bounced transition, with what was cancelled", async () => {
    db = seed({
      email_follow_ups: [
        { id: 21, user_id: USER, status: "active", recipient_email: "dana@corp.com" },
      ],
      email_follow_up_messages: [{ id: 31, follow_up_id: 21, status: "pending" }],
      scheduled_emails: [
        { id: 11, user_id: USER, to_email: "dana@corp.com", status: "pending" },
      ],
    });

    const result = await detectBounces(USER);

    expect(result.newlyBounced).toEqual(["dana@corp.com"]);
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0].items).toEqual([
      {
        contactName: "Dana Reed",
        address: "dana@corp.com",
        contactId: 7,
        cancelledFollowUps: 1,
        cancelledScheduled: 1,
      },
    ]);
  });

  it("does NOT re-alert an address that was already flagged", async () => {
    // The daily cron re-reads the same 14-day NDR window every run. Re-emailing
    // about a known-dead address every day would train the user to ignore it.
    db = seed({
      contact_emails: [
        {
          id: 1,
          contact_id: 7,
          email: "dana@corp.com",
          bounced_at: "2026-08-01T00:00:00.000Z",
          contacts: { user_id: USER, name: "Dana Reed" },
        },
      ],
    });

    const result = await detectBounces(USER);

    expect(result.bounced).toEqual(["dana@corp.com"]); // still seen
    expect(result.newlyBounced).toEqual([]); // but not new
    expect(alertCalls[0].items).toEqual([]);
  });

  it("sends ONE alert covering every address that died in the pass", async () => {
    fake = createFakeGmail({
      pages: [[headerNdr("ndr-1", "dana@corp.com"), headerNdr("ndr-2", "sam@corp.com")]],
    });
    db = seed({
      contacts: [
        { id: 7, user_id: USER, name: "Dana Reed" },
        { id: 8, user_id: USER, name: "Sam Vale" },
      ],
      contact_emails: [
        { id: 1, contact_id: 7, email: "dana@corp.com", bounced_at: null, contacts: { user_id: USER, name: "Dana Reed" } },
        { id: 2, contact_id: 8, email: "sam@corp.com", bounced_at: null, contacts: { user_id: USER, name: "Sam Vale" } },
      ],
    });

    await detectBounces(USER);

    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0].items.map((i) => i.address).sort()).toEqual(["dana@corp.com", "sam@corp.com"]);
  });

  it("ignores an NDR for an address that is not one of this user's contacts", async () => {
    fake = createFakeGmail({ pages: [[headerNdr("ndr-1", "stranger@elsewhere.com")]] });

    const result = await detectBounces(USER);

    expect(result.bounced).toEqual([]);
    expect(alertCalls[0].items).toEqual([]);
  });
});

describe("detectBounces — two-phase fetch", () => {
  it("resolves a report-only NDR that carries no X-Failed-Recipients header", async () => {
    fake = createFakeGmail({ pages: [[reportNdr("ndr-1", "dana@corp.com")]] });

    const result = await detectBounces(USER);

    expect(result.newlyBounced).toEqual(["dana@corp.com"]);
    expect(db.tables.contact_emails[0].bounced_at).not.toBeNull();
  });

  it("re-fetches 'full' ONLY for the message the metadata pass could not resolve", async () => {
    fake = createFakeGmail({
      pages: [[headerNdr("ndr-1", "dana@corp.com"), reportNdr("ndr-2", "sam@corp.com")]],
    });
    db = seed({
      contacts: [
        { id: 7, user_id: USER, name: "Dana Reed" },
        { id: 8, user_id: USER, name: "Sam Vale" },
      ],
      contact_emails: [
        { id: 1, contact_id: 7, email: "dana@corp.com", bounced_at: null, contacts: { user_id: USER, name: "Dana Reed" } },
        { id: 2, contact_id: 8, email: "sam@corp.com", bounced_at: null, contacts: { user_id: USER, name: "Sam Vale" } },
      ],
    });

    await detectBounces(USER);

    const full = fake.state.getFormats.filter((g) => g.format === "full");
    // The header-resolved message must not pay for a second, heavier fetch.
    expect(full.map((g) => g.id)).toEqual(["ndr-2"]);
    expect(fake.state.getFormats.filter((g) => g.format === "metadata").map((g) => g.id).sort()).toEqual([
      "ndr-1",
      "ndr-2",
    ]);
  });

  it("makes no Gmail calls at all when the NDR search is empty", async () => {
    fake = createFakeGmail({ pages: [[]] });

    const result = await detectBounces(USER);

    expect(result.bounced).toEqual([]);
    expect(fake.state.getCalls).toEqual([]);
    expect(alertCalls).toHaveLength(0); // not even a no-op alert call
  });
});
