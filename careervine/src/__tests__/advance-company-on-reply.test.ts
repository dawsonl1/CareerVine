import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";

/**
 * CAR-243: a reply moves the replier's CURRENT employer to Active outreach, and
 * it does so from the sync path replies actually arrive on.
 *
 * CAR-239 built the advance but hung it off `syncThreadReplies`. /api/gmail/sync
 * runs `syncAllContactEmails` FIRST, and that loop queries Gmail by the contact's
 * own addresses — so it inserts the reply, and the sweep (which only advances
 * threads whose rows IT inserted) then sees a duplicate and an empty set. On
 * production that left 11 targeted companies on Researching after their contact
 * had written back.
 *
 * So these drive the REAL `syncEmailsForContact` loop rather than the helper in
 * isolation: "a reply advances the company" is a claim about the WIRING, and the
 * helper's own unit tests already passed while the app did nothing.
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

import { syncEmailsForContact } from "@/lib/gmail";

const USER = "user-1";
const CONTACT = 7;
const THREAD = "t1";
/** Where the contact works now. */
const CURRENT_CO = 100;
/** Where they used to work. */
const FORMER_CO = 101;

/**
 * The contact works at CURRENT_CO and used to work at FORMER_CO; both are
 * targeted and both sit on Researching. `contacts: { user_id }` is the nested
 * shape the `contacts!inner(user_id)` embed reads through.
 */
function seed(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  db = createFakeSyncDb({
    contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "prospect" }],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    email_messages: [],
    contact_companies: [
      { contact_id: CONTACT, company_id: CURRENT_CO, is_current: true, contacts: { user_id: USER } },
      { contact_id: CONTACT, company_id: FORMER_CO, is_current: false, contacts: { user_id: USER } },
    ],
    target_companies: [
      { id: 10, user_id: USER, company_id: CURRENT_CO, status: "researching", active_cycle: 1, is_deleted: false },
      { id: 11, user_id: USER, company_id: FORMER_CO, status: "researching", active_cycle: 1, is_deleted: false },
    ],
    ...overrides,
  });
}

/** One inbound message from the contact. */
function replyPage() {
  return createFakeGmail({
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
}

const statusOf = (id: number) =>
  db.tables.target_companies.find((t) => t.id === id)?.status;

beforeEach(() => {
  seed();
  fake = createFakeGmail();
});

describe("syncEmailsForContact — a reply advances the company (CAR-243)", () => {
  it("moves the contact's current employer to Active outreach", async () => {
    fake = replyPage();

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(statusOf(10)).toBe("outreach_active");
    // The pre-existing reply behavior still holds.
    expect(db.tables.contacts[0].network_status).toBe("active");
  });

  it("leaves a company the contact has already left on Researching", async () => {
    fake = replyPage();

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    // Outreach is not active at a company someone left years ago. Without the
    // is_current filter one reply advanced every employer on their resume.
    expect(statusOf(11)).toBe("researching");
  });

  it("never drags a company backwards from a later stage", async () => {
    seed({
      target_companies: [
        { id: 10, user_id: USER, company_id: CURRENT_CO, status: "applied", active_cycle: 1, is_deleted: false },
      ],
    });
    fake = replyPage();

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(statusOf(10)).toBe("applied");
  });

  it("does not touch another user's target for the same company", async () => {
    seed({
      target_companies: [
        { id: 99, user_id: "user-2", company_id: CURRENT_CO, status: "researching", active_cycle: 1 },
      ],
    });
    fake = replyPage();

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(statusOf(99)).toBe("researching");
  });

  it("does not advance on our own outbound mail", async () => {
    fake = createFakeGmail({
      pages: [[
        { id: "m-out", threadId: THREAD, from: "me@gmail.com", to: "jane@corp.com", subject: "hi", date: "Mon, 13 Jul 2026 10:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(statusOf(10)).toBe("researching");
    // A sync that ingested no reply must not pay for the lookup either.
    expect(db.opsFor("contact_companies")).toHaveLength(0);
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

    // Advancing here would mark outreach "active" off the very address that
    // just failed to deliver.
    expect(statusOf(10)).toBe("researching");
  });

  it("a failed advance does not fail the mailbox sync", async () => {
    db = createFakeSyncDb(
      {
        contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "prospect" }],
        gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
        email_messages: [],
        contact_companies: [
          { contact_id: CONTACT, company_id: CURRENT_CO, is_current: true, contacts: { user_id: USER } },
        ],
        target_companies: [
          { id: 10, user_id: USER, company_id: CURRENT_CO, status: "researching", active_cycle: 1, is_deleted: false },
        ],
      },
      { failOn: (table, op) => (table === "contact_companies" && op === "select" ? "boom" : null) },
    );
    fake = replyPage();

    // A stale pipeline stage is a cosmetic problem; a sync that throws loses the
    // user's mail. The reply itself must still land.
    await expect(
      syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]),
    ).resolves.toBeDefined();
    expect(db.tables.email_messages).toHaveLength(1);
    expect(statusOf(10)).toBe("researching");
  });
});
