import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * CAR-276: answering a thread marks it read.
 *
 * ONE invariant — an inbound message is read if you sent an outbound message on
 * the same thread at a LATER time — enforced from three places, all pinned here:
 *
 *   1. `reconcileThreadReadState` itself, including the cases it deliberately
 *      declines to mark (no reply, reply predates the message, unusable date).
 *   2. `sendTrackedEmail`, the choke point every outbound path funnels through.
 *   3. The two sync ingest paths, for a reply the user sent from Gmail or their
 *      phone, which our row never hears about otherwise.
 *
 * The monotonic direction is the load-bearing property and has its own case:
 * this must never move a row from read back to unread, because that is exactly
 * what syncEmailsForContact's "never overwrite is_read" guard exists to prevent.
 */

let fake = createFakeGmail();
let db = createFakeSyncDb();
let sendResult = { messageId: "sent-1", threadId: "thread-1" };

vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: async () => fake.gmail,
  getConnection: async () => (db.tables.gmail_connections ?? [])[0] ?? null,
  buildMimeMessage: () => "",
  sendEmail: async () => sendResult,
}));
vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule(() => db.client));
vi.mock("@/lib/analytics/server", () =>
  mockAnalyticsServerModule({
    trackServer: async () => {},
    checkCompaniesEmailedMilestone: async () => {},
  }),
);

import { reconcileThreadReadState } from "@/lib/email-read";
import { sendTrackedEmail } from "@/lib/email-send";
import { syncEmailsForContact, syncThreadReplies } from "@/lib/gmail";

const USER = "user-1";
const OTHER_USER = "user-2";
const CONTACT = 7;
const THREAD = "thread-1";
const THEIR_ADDR = "jane@corp.com";
const MY_ADDR = "me@gmail.com";

/**
 * Their message, unread, at 10:00.
 *
 * matched_contact_id and the nested junction row are what make THREAD a thread
 * syncThreadReplies recognizes: it builds contactsByThread from exactly those
 * two columns and skips any message on a thread that resolves to no contact.
 */
function inbound(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: USER,
    gmail_message_id: "in-1",
    thread_id: THREAD,
    direction: "inbound",
    from_address: THEIR_ADDR,
    date: "2026-08-05T10:00:00Z",
    is_read: false,
    is_simulated: false,
    matched_contact_id: CONTACT,
    email_message_contacts: [{ contact_id: CONTACT }],
    ...over,
  };
}

/** Our answer, at 11:00 — an hour after theirs. */
function outbound(over: Record<string, unknown> = {}) {
  return {
    id: 2,
    user_id: USER,
    gmail_message_id: "out-1",
    thread_id: THREAD,
    direction: "outbound",
    from_address: MY_ADDR,
    date: "2026-08-05T11:00:00Z",
    is_read: true,
    is_simulated: false,
    matched_contact_id: CONTACT,
    email_message_contacts: [{ contact_id: CONTACT }],
    ...over,
  };
}

function setup(messages: Record<string, unknown>[], gmailOpts: Parameters<typeof createFakeGmail>[0] = {}) {
  fake = createFakeGmail(gmailOpts);
  db = createFakeSyncDb({
    gmail_connections: [
      { user_id: USER, gmail_address: MY_ADDR, send_as_aliases: [], modify_scope_granted: true },
    ],
    contacts: [{ id: CONTACT, user_id: USER, name: "Jane", network_status: "active", email_synced_through: null }],
    // The nested `contacts` object is how the fake resolves sendTrackedEmail's
    // joined `.eq("contacts.user_id", …)` provenance filter.
    contact_emails: [
      { id: 1, contact_id: CONTACT, email: THEIR_ADDR, is_primary: true, source: "verified", bounced_at: null, contacts: { user_id: USER } },
    ],
    email_messages: messages,
    email_message_contacts: [],
  });
  sendResult = { messageId: "sent-1", threadId: THREAD };
}

const client = () => db.client as unknown as SupabaseClient;
const rowFor = (gmailMessageId: string) =>
  db.tables.email_messages.find((m) => m.gmail_message_id === gmailMessageId)!;

beforeEach(() => setup([inbound(), outbound()]));

describe("reconcileThreadReadState", () => {
  it("marks an unread inbound message that the reply answered", async () => {
    const marked = await reconcileThreadReadState(client(), USER, [THREAD]);

    expect(marked).toBe(1);
    expect(rowFor("in-1").is_read).toBe(true);
  });

  it("leaves a message that arrived AFTER the reply unread", async () => {
    // The whole point of deriving a cutoff rather than marking the thread: mail
    // that landed after you wrote back is mail you have not dealt with.
    setup([
      inbound(),
      outbound(),
      inbound({ id: 3, gmail_message_id: "in-2", date: "2026-08-05T12:00:00Z" }),
    ]);

    const marked = await reconcileThreadReadState(client(), USER, [THREAD]);

    expect(marked).toBe(1);
    expect(rowFor("in-1").is_read).toBe(true);
    expect(rowFor("in-2").is_read).toBe(false);
  });

  it("leaves a thread we never answered alone", async () => {
    setup([inbound()]);

    expect(await reconcileThreadReadState(client(), USER, [THREAD])).toBe(0);
    expect(rowFor("in-1").is_read).toBe(false);
    // Not merely unchanged — no write was attempted at all.
    expect(db.opsFor("email_messages", "update")).toHaveLength(0);
  });

  it("leaves a message with an unusable date unread rather than guessing", async () => {
    // A missing or unparseable Date header cannot PROVE the message predates the
    // reply. Failing toward "still unread" costs a badge one too high; failing
    // the other way hides mail the user never saw.
    setup([inbound({ date: null }), outbound()]);

    expect(await reconcileThreadReadState(client(), USER, [THREAD])).toBe(0);
    expect(rowFor("in-1").is_read).toBe(false);
  });

  it("never moves a row from read back to unread", async () => {
    // The monotonic property syncEmailsForContact's is_read guard depends on.
    // An inbound AFTER the reply is the case that would expose a two-way write.
    setup([
      inbound({ is_read: true }),
      outbound(),
      inbound({ id: 3, gmail_message_id: "in-2", date: "2026-08-05T12:00:00Z", is_read: true }),
    ]);

    await reconcileThreadReadState(client(), USER, [THREAD]);

    expect(rowFor("in-1").is_read).toBe(true);
    expect(rowFor("in-2").is_read).toBe(true);
    for (const op of db.opsFor("email_messages", "update")) {
      expect(op.values).not.toMatchObject({ is_read: false });
    }
  });

  it("stays inside the user, even on a thread id two tenants share", async () => {
    setup([
      inbound(),
      outbound(),
      inbound({ id: 3, user_id: OTHER_USER, gmail_message_id: "in-other" }),
      outbound({ id: 4, user_id: OTHER_USER, gmail_message_id: "out-other" }),
    ]);

    const marked = await reconcileThreadReadState(client(), USER, [THREAD]);

    // The COUNT matters as much as the rows: the write filter alone would keep
    // the other tenant's row unwritten while the unread read still collected it,
    // which is a leak that only shows up in the return value.
    expect(marked).toBe(1);
    expect(rowFor("in-1").is_read).toBe(true);
    expect(rowFor("in-other").is_read).toBe(false);
  });

  it("scopes its write to the user as well as its reads", async () => {
    // Asserted on the filter rather than on an outcome, deliberately. The ids
    // being written were just read back under a user filter, so the two scopings
    // are individually redundant and no fixture can distinguish them — which is
    // exactly why dropping one is a silent change. CAR-151's rule is that a
    // service-role write carries its own scope regardless, so pin the rule.
    await reconcileThreadReadState(client(), USER, [THREAD]);

    const writes = db.opsFor("email_messages", "update");
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toContainEqual(["eq:user_id", USER]);
  });

  it("ignores the other user's reply when deciding our cutoff", async () => {
    // Scoping the WRITE is not enough: if the outbound read leaked across
    // tenants, their reply would mark our unread message read.
    setup([inbound(), outbound({ id: 2, user_id: OTHER_USER, gmail_message_id: "out-other" })]);

    expect(await reconcileThreadReadState(client(), USER, [THREAD])).toBe(0);
    expect(rowFor("in-1").is_read).toBe(false);
  });

  it("does nothing on an empty thread list without touching the database", async () => {
    await reconcileThreadReadState(client(), USER, []);
    expect(db.ops).toHaveLength(0);
  });

  describe("Gmail label sync", () => {
    it("clears UNREAD for exactly the messages it marked, when asked to", async () => {
      setup([
        inbound(),
        outbound(),
        inbound({ id: 3, gmail_message_id: "in-2", date: "2026-08-05T12:00:00Z" }),
      ]);

      await reconcileThreadReadState(client(), USER, [THREAD], { syncGmail: true });

      // Not threads.modify: that would clear UNREAD across the whole thread,
      // including in-2, which arrived after the reply and stays unread.
      expect(fake.state.modifyCalls).toEqual([
        { id: "in-1", addLabelIds: [], removeLabelIds: ["UNREAD"] },
      ]);
    });

    it("does not touch Gmail on the sync path, where Gmail already agrees", async () => {
      await reconcileThreadReadState(client(), USER, [THREAD]);

      expect(rowFor("in-1").is_read).toBe(true);
      expect(fake.state.modifyCalls).toHaveLength(0);
    });

    it("keeps the local read state when the Gmail call fails", async () => {
      // DB first, Gmail best-effort: a token refresh failure or a rate limit
      // must not undo a state change the user already earned.
      setup([inbound(), outbound()], { failModifyFor: new Set(["in-1"]) });

      await expect(
        reconcileThreadReadState(client(), USER, [THREAD], { syncGmail: true }),
      ).resolves.toBe(1);
      expect(rowFor("in-1").is_read).toBe(true);
    });

    it("never sends a simulated message's placeholder id to Gmail", async () => {
      // The free tier's `manual-reply-<threadId>` row carries an id Gmail has
      // never heard of.
      setup([
        inbound({ gmail_message_id: `manual-reply-${THREAD}`, is_simulated: true }),
        outbound(),
      ]);

      await reconcileThreadReadState(client(), USER, [THREAD], { syncGmail: true });

      expect(rowFor(`manual-reply-${THREAD}`).is_read).toBe(true);
      expect(fake.state.modifyCalls).toHaveLength(0);
    });
  });
});

describe("the send path", () => {
  it("marks the thread read when you reply through CareerVine", async () => {
    // Only their message is seeded: the outbound that becomes the cutoff is the
    // one sendTrackedEmail caches for itself, which is why the reconcile has to
    // run after that upsert rather than before it.
    setup([inbound()]);

    await sendTrackedEmail(USER, {
      to: THEIR_ADDR,
      subject: "Re: coffee",
      bodyHtml: "<p>Sounds great.</p>",
      threadId: THREAD,
    });

    expect(rowFor("in-1").is_read).toBe(true);
    expect(fake.state.modifyCalls).toEqual([
      { id: "in-1", addLabelIds: [], removeLabelIds: ["UNREAD"] },
    ]);
  });

  it("still reports the send as successful when the reconcile throws", async () => {
    // The mail is already gone. A failed display-flag write must not be
    // reported back to the caller as a failed send.
    setup([inbound()]);
    db = createFakeSyncDb(
      { ...db.tables },
      { failOn: (table, op) => (table === "email_messages" && op === "update" ? "boom" : null) },
    );

    const result = await sendTrackedEmail(USER, {
      to: THEIR_ADDR,
      subject: "Re: coffee",
      bodyHtml: "<p>Sounds great.</p>",
      threadId: THREAD,
    });

    expect(result.messageId).toBe("sent-1");
    expect(rowFor("in-1").is_read).toBe(false);
  });

  it("does not reconcile cold outreach, which has no thread to answer", async () => {
    setup([]);
    sendResult = { messageId: "sent-1", threadId: "" };

    await sendTrackedEmail(USER, { to: THEIR_ADDR, subject: "Hello", bodyHtml: "<p>Hi</p>" });

    expect(db.opsFor("email_messages", "update")).toHaveLength(0);
  });
});

describe("the sync path — a reply sent from Gmail or a phone", () => {
  it("marks the thread read when the per-contact sync ingests our own message", async () => {
    // The stuck case exactly: their message synced in while it was genuinely
    // unread, so the row was written false. The user then answered from Gmail,
    // which cleared UNREAD on Google's side only. Our row never hears about it,
    // because the update branch below deliberately never revisits is_read.
    setup([inbound()], {
      pages: [
        [
          {
            id: "out-1",
            threadId: THREAD,
            from: `Me <${MY_ADDR}>`,
            to: THEIR_ADDR,
            subject: "Re: coffee",
            date: "Wed, 05 Aug 2026 11:00:00 +0000",
            labelIds: ["SENT"],
          },
        ],
      ],
    });

    await syncEmailsForContact(USER, CONTACT, [THEIR_ADDR], [MY_ADDR], 90);

    expect(rowFor("in-1").is_read).toBe(true);
  });

  it("leaves read state alone when the sync only ingests their new message", async () => {
    // An inbound arriving on a thread we answered LONG ago must not be swept up
    // by the reply that predates it.
    setup([outbound()], {
      pages: [
        [
          {
            id: "in-2",
            threadId: THREAD,
            from: `Jane <${THEIR_ADDR}>`,
            to: MY_ADDR,
            subject: "Re: coffee",
            date: "Wed, 05 Aug 2026 12:00:00 +0000",
            labelIds: ["INBOX", "UNREAD"],
          },
        ],
      ],
    });

    await syncEmailsForContact(USER, CONTACT, [THEIR_ADDR], [MY_ADDR], 90);

    expect(rowFor("in-2").is_read).toBe(false);
  });

  it("marks the thread read when the thread sweep ingests our own message", async () => {
    // The sweep is the only path that sees a message the address-scoped query
    // cannot (CAR-227), so it needs the same reconcile.
    setup([inbound(), outbound({ id: 2, gmail_message_id: "out-old", date: "2026-08-04T09:00:00Z" })], {
      pages: [
        [
          {
            id: "out-2",
            threadId: THREAD,
            from: `Me <${MY_ADDR}>`,
            to: THEIR_ADDR,
            subject: "Re: coffee",
            date: "Wed, 05 Aug 2026 11:00:00 +0000",
            labelIds: ["SENT"],
          },
        ],
      ],
    });

    await syncThreadReplies(USER, { sinceDays: 90 });

    expect(rowFor("in-1").is_read).toBe(true);
  });
});
