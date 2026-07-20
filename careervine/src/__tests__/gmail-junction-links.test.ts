import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";

/**
 * CAR-159: multi-contact email attribution through the email_message_contacts
 * junction, driven end-to-end through the REAL sync/backfill code on the
 * fake-gmail harness (CAR-153).
 *
 * Pinned here:
 *   1. The R2.7 fixture: a thread involving two tracked contacts (recruiter +
 *      hiring manager) is attributed to BOTH — whichever order they sync in —
 *      while matched_contact_id keeps only the first (denormalized primary).
 *   2. Concurrent-sync idempotency: the (email_message_id, contact_id) UNIQUE
 *      pair plus ignoreDuplicates means overlapping syncs of the same contact
 *      produce exactly one link.
 *   3. backfillEmailsForContact links EVERY matching message — including rows
 *      already claimed by another contact, which the legacy orphan-claim pass
 *      (matched_contact_id IS NULL) can never re-attribute.
 */

const USER = "user-1";
const RECRUITER = 7;
const HIRING_MANAGER = 8;

let fake = createFakeGmail();
let db = createFakeSyncDb();

vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: async () => fake.gmail,
  getConnection: async () => (db.tables.gmail_connections ?? [])[0] ?? null,
  buildMimeMessage: () => "",
  sendEmail: async () => ({ messageId: "m", threadId: "t" }),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => db.client,
}));

vi.mock("@/lib/analytics/server", () => ({
  trackServer: async () => {},
  checkCompaniesEmailedMilestone: async () => {},
}));

import { syncEmailsForContact, backfillEmailsForContact } from "@/lib/gmail";

// The shared intro thread: recruiter in From, hiring manager in To alongside
// the user — one Gmail message that both contacts' sync queries match.
const INTRO_MESSAGE = {
  id: "msg-intro",
  threadId: "thr-intro",
  from: "Recruiter <recruiter@corp.com>",
  to: "me@gmail.com, hm@corp.com",
  subject: "Intro: you two should talk",
  date: "2026-07-01T10:00:00Z",
};

function seedDb(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  db = createFakeSyncDb({
    contacts: [
      { id: RECRUITER, user_id: USER, email_synced_through: null, network_status: "active" },
      { id: HIRING_MANAGER, user_id: USER, email_synced_through: null, network_status: "active" },
    ],
    email_messages: [],
    email_message_contacts: [],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    ...overrides,
  });
}

function junctionLinks() {
  return (db.tables.email_message_contacts ?? []).map((l) => ({
    email_message_id: l.email_message_id,
    contact_id: l.contact_id,
  }));
}

beforeEach(() => {
  fake = createFakeGmail({ pages: [[INTRO_MESSAGE]] });
  seedDb();
});

describe("multi-contact sync attribution (R2.7 fixture)", () => {
  it("links a shared thread to both contacts regardless of sync order; matched_contact_id keeps the first", async () => {
    await syncEmailsForContact(USER, RECRUITER, ["recruiter@corp.com"], "me@gmail.com");
    await syncEmailsForContact(USER, HIRING_MANAGER, ["hm@corp.com"], "me@gmail.com");

    // One cached row — the second sync saw it existing and did not duplicate.
    const messages = db.tables.email_messages;
    expect(messages).toHaveLength(1);
    const messageId = messages[0].id as number;
    // Denormalized primary stays with the first claimer.
    expect(messages[0].matched_contact_id).toBe(RECRUITER);

    // ... but the junction attributes it to BOTH.
    expect(junctionLinks()).toEqual(
      expect.arrayContaining([
        { email_message_id: messageId, contact_id: RECRUITER },
        { email_message_id: messageId, contact_id: HIRING_MANAGER },
      ])
    );
    expect(junctionLinks()).toHaveLength(2);
  });

  it("is idempotent across repeated syncs of the same contact (UNIQUE pair)", async () => {
    await syncEmailsForContact(USER, RECRUITER, ["recruiter@corp.com"], "me@gmail.com");
    // Second pass re-fetches the same message (overlap window) — the
    // ignoreDuplicates upsert on the UNIQUE pair must not double-link.
    await syncEmailsForContact(USER, RECRUITER, ["recruiter@corp.com"], "me@gmail.com");

    expect(db.tables.email_messages).toHaveLength(1);
    expect(junctionLinks()).toEqual([
      { email_message_id: db.tables.email_messages[0].id, contact_id: RECRUITER },
    ]);
  });

  it("links concurrent syncs of two contacts over the same message without loss", async () => {
    // Hold both list calls open so the two syncs interleave.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    fake = createFakeGmail({ pages: [[INTRO_MESSAGE]], listGate: () => gate });

    const a = syncEmailsForContact(USER, RECRUITER, ["recruiter@corp.com"], "me@gmail.com");
    const b = syncEmailsForContact(USER, HIRING_MANAGER, ["hm@corp.com"], "me@gmail.com");
    release();
    await Promise.all([a, b]);

    expect(db.tables.email_messages).toHaveLength(1);
    const messageId = db.tables.email_messages[0].id as number;
    expect(junctionLinks()).toEqual(
      expect.arrayContaining([
        { email_message_id: messageId, contact_id: RECRUITER },
        { email_message_id: messageId, contact_id: HIRING_MANAGER },
      ])
    );
    expect(junctionLinks()).toHaveLength(2);
  });
});

describe("backfillEmailsForContact junction pass", () => {
  it("links messages already claimed by another contact (the un-claimable case) AND claims orphans", async () => {
    seedDb({
      email_messages: [
        {
          // Already claimed by the recruiter when their sync ran first.
          id: 100,
          user_id: USER,
          gmail_message_id: "msg-intro",
          from_address: "recruiter@corp.com",
          to_addresses: ["me@gmail.com", "hm@corp.com"],
          matched_contact_id: RECRUITER,
        },
        {
          // Orphaned direct mail from the hiring manager, cached before they
          // became a contact.
          id: 101,
          user_id: USER,
          gmail_message_id: "msg-direct",
          from_address: "hm@corp.com",
          to_addresses: ["me@gmail.com"],
          matched_contact_id: null,
        },
      ],
      email_message_contacts: [{ email_message_id: 100, contact_id: RECRUITER }],
    });

    const claimed = await backfillEmailsForContact(USER, HIRING_MANAGER, ["HM@corp.com"]);

    // Legacy pass: only the orphan is claimable.
    expect(claimed).toBe(1);
    expect(db.tables.email_messages.find((m) => m.id === 101)?.matched_contact_id).toBe(HIRING_MANAGER);
    expect(db.tables.email_messages.find((m) => m.id === 100)?.matched_contact_id).toBe(RECRUITER);

    // Junction pass: both messages now attribute to the hiring manager, and
    // the recruiter's existing link is untouched.
    expect(junctionLinks()).toEqual(
      expect.arrayContaining([
        { email_message_id: 100, contact_id: RECRUITER },
        { email_message_id: 100, contact_id: HIRING_MANAGER },
        { email_message_id: 101, contact_id: HIRING_MANAGER },
      ])
    );
    expect(junctionLinks()).toHaveLength(3);
  });

  it("is idempotent: re-running the backfill adds no duplicate links", async () => {
    seedDb({
      email_messages: [
        {
          id: 100,
          user_id: USER,
          gmail_message_id: "msg-direct",
          from_address: "hm@corp.com",
          to_addresses: ["me@gmail.com"],
          matched_contact_id: null,
        },
      ],
    });

    await backfillEmailsForContact(USER, HIRING_MANAGER, ["hm@corp.com"]);
    await backfillEmailsForContact(USER, HIRING_MANAGER, ["hm@corp.com"]);

    expect(junctionLinks()).toEqual([{ email_message_id: 100, contact_id: HIRING_MANAGER }]);
  });
});
