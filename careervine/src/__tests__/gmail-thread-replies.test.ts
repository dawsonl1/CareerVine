import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";

/**
 * CAR-227: replies that arrive from an address we do not have on the contact.
 *
 * The per-contact sync queries Gmail as `from:<known> OR to:<known>`, so a
 * reply sent from any other address is invisible to it — however plainly it
 * belongs to a thread we already hold. The live case this reproduces: outreach
 * to smita.verma@adobe.com (a scraped address that routes to her) answered
 * from smiverma@adobe.com. Both replies stayed unsynced while the thread sat
 * in the inbox looking unanswered, and the follow-up cron — which reads whole
 * threads — had already decided she HAD replied. The two disagreed.
 *
 * Driven through the real syncThreadReplies on the fake-gmail harness.
 */

const trackServer = vi.hoisted(() => vi.fn(async () => {}));

let fake = createFakeGmail();
let db = createFakeSyncDb();

vi.mock("@/lib/gmail-send-core", () => ({
  getGmailClient: async () => fake.gmail,
  getConnection: async () => (db.tables.gmail_connections ?? [])[0] ?? null,
  buildMimeMessage: () => "",
  sendEmail: async () => ({ messageId: "m", threadId: "t" }),
}));
vi.mock("@/lib/supabase/service-client", () => mockServiceClientModule(() => db.client));
vi.mock("@/lib/analytics/server", () =>
  mockAnalyticsServerModule({ trackServer, checkCompaniesEmailedMilestone: async () => {} }),
);

import { syncThreadReplies, syncEmailsForContact } from "@/lib/gmail";

const USER = "user-1";
const SMITA = 103;
const SENT_ADDR = "smita.verma@adobe.com";
const REPLY_ADDR = "smiverma@adobe.com";
const THREAD = "thread-adobe";

/** The outbound we already hold, which is what makes THREAD a known thread. */
function seedOutbound(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    user_id: USER,
    gmail_message_id: "out-1",
    thread_id: THREAD,
    direction: "outbound",
    from_address: "me@gmail.com",
    to_addresses: [SENT_ADDR],
    date: "2026-08-04T15:30:06Z",
    matched_contact_id: SMITA,
    ai_assisted: false,
    email_message_contacts: [{ contact_id: SMITA }],
    ...over,
  };
}

/** Her reply, from the address we have never seen. */
const REPLY = {
  id: "reply-1",
  threadId: THREAD,
  from: `Smita Verma <${REPLY_ADDR}>`,
  to: "me@gmail.com",
  subject: "Re: BYU senior, question about your work at Adobe",
  date: "Tue, 04 Aug 2026 16:55:50 +0000",
  snippet: "Sure, how does 12 pm cst next Friday sound?",
  labelIds: ["INBOX", "UNREAD"],
};

function setup(opts: { pages?: NonNullable<Parameters<typeof createFakeGmail>[0]>["pages"]; contacts?: Record<string, unknown>[]; messages?: Record<string, unknown>[] } = {}) {
  fake = createFakeGmail({ pages: opts.pages ?? [[REPLY]] });
  db = createFakeSyncDb({
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com", send_as_aliases: [], modify_scope_granted: true }],
    contacts: opts.contacts ?? [{ id: SMITA, user_id: USER, name: "Smita Verma", network_status: "active" }],
    contact_emails: [{ id: 1, contact_id: SMITA, email: SENT_ADDR, is_primary: true, source: "scraped" }],
    email_messages: opts.messages ?? [seedOutbound()],
    email_message_contacts: [{ email_message_id: 1, contact_id: SMITA }],
  });
}

beforeEach(() => {
  trackServer.mockClear();
});

describe("the blind spot this pass exists to cover", () => {
  it("the per-contact query can only ever match addresses we already have", async () => {
    setup();
    await syncEmailsForContact(USER, SMITA, [SENT_ADDR], ["me@gmail.com"], 90);

    // This is the whole bug, stated as an assertion rather than a comment: the
    // Gmail query is built from contact_emails, so an address the contact
    // writes from but we have never recorded is unreachable by construction.
    // No watermark tuning or extra passes of THIS query can find her reply.
    const q = fake.state.listCalls[0].q;
    expect(q).toContain(SENT_ADDR);
    expect(q).not.toContain(REPLY_ADDR);
  });
});

describe("syncThreadReplies — replies from an unknown address (CAR-227)", () => {
  it("ingests a reply the address-scoped sync can never match", async () => {
    setup();
    const result = await syncThreadReplies(USER);

    expect(result.ingested).toBe(1);
    const stored = db.tables.email_messages.find((m) => m.gmail_message_id === "reply-1");
    expect(stored).toBeTruthy();
    expect(stored!.direction).toBe("inbound");
    expect(stored!.from_address).toBe(REPLY_ADDR);
    expect(stored!.thread_id).toBe(THREAD);
    // Attributed to the contact the thread already belonged to, not left orphaned.
    expect(stored!.matched_contact_id).toBe(SMITA);
    expect(db.tables.email_message_contacts.some((l) => l.email_message_id === stored!.id && l.contact_id === SMITA)).toBe(true);
  });

  it("learns the address she actually writes from", async () => {
    setup();
    const result = await syncThreadReplies(USER);

    expect(result.learnedAddresses).toBe(1);
    const learned = db.tables.contact_emails.find((e) => e.email === REPLY_ADDR);
    expect(learned).toBeTruthy();
    expect(learned!.contact_id).toBe(SMITA);
    // Provably hers — she wrote from it.
    expect(learned!.source).toBe("verified");
    // The address we have been successfully reaching her on keeps primary.
    expect(learned!.is_primary).toBe(false);
    expect(db.tables.contact_emails.find((e) => e.email === SENT_ADDR)!.is_primary).toBe(true);
  });

  it("graduates an imported prospect on the reply", async () => {
    setup({ contacts: [{ id: SMITA, user_id: USER, name: "Smita Verma", network_status: "prospect" }] });
    await syncThreadReplies(USER);
    expect(db.tables.contacts.find((c) => c.id === SMITA)!.network_status).toBe("active");
  });

  it("fires reply_received when we had sent on the thread first", async () => {
    setup();
    await syncThreadReplies(USER);
    expect(trackServer).toHaveBeenCalledWith(USER, "reply_received", { ai_assisted: false });
  });

  // Two independent guards hold this: the already-known-message filter before
  // the metadata fetch, and ON CONFLICT DO NOTHING on the insert. Removing
  // either alone leaves the property intact, which is the point of having both
  // — a concurrent sync can insert between the list and the upsert.
  it("is idempotent — a second pass re-ingests nothing", async () => {
    setup();
    expect((await syncThreadReplies(USER)).ingested).toBe(1);

    const before = db.tables.email_messages.length;
    trackServer.mockClear();
    const second = await syncThreadReplies(USER);

    expect(second.ingested).toBe(0);
    expect(second.learnedAddresses).toBe(0);
    expect(db.tables.email_messages).toHaveLength(before);
    // The north-star event must not double-count on a re-sync.
    expect(trackServer).not.toHaveBeenCalled();
  });
});

describe("syncThreadReplies — what it must NOT pull in", () => {
  it("ignores mail on a thread we do not track, without paying for a metadata fetch", async () => {
    setup({
      pages: [[REPLY, { id: "spam-1", threadId: "thread-unknown", from: "deals@shop.example", to: "me@gmail.com", subject: "50% off", date: "Tue, 04 Aug 2026 17:00:00 +0000" }]],
    });
    await syncThreadReplies(USER);

    expect(db.tables.email_messages.some((m) => m.gmail_message_id === "spam-1")).toBe(false);
    // threadId rides along on the list response, so an unrelated message is
    // discarded before it can cost an API call. This is what keeps the sweep
    // bounded by the time window rather than by mailbox volume.
    expect(fake.state.getCalls).toEqual(["reply-1"]);
  });

  it("skips a bounce notification sitting inside a tracked thread", async () => {
    setup({
      pages: [[{ id: "ndr-1", threadId: THREAD, from: "mailer-daemon@googlemail.com", to: "me@gmail.com", subject: "Delivery Status Notification (Failure)", date: "Tue, 04 Aug 2026 16:00:00 +0000" }]],
      contacts: [{ id: SMITA, user_id: USER, name: "Smita Verma", network_status: "prospect" }],
    });
    const result = await syncThreadReplies(USER);

    // A delivery failure is not a reply. Ingesting it would activate the very
    // contact whose address just failed; detectBounces owns this message.
    expect(result.ingested).toBe(0);
    expect(db.tables.contacts.find((c) => c.id === SMITA)!.network_status).toBe("prospect");
    expect(db.tables.contact_emails.some((e) => String(e.email).startsWith("mailer-daemon"))).toBe(false);
  });

  it("does not learn an address from a thread shared by two contacts", async () => {
    setup({
      contacts: [
        { id: SMITA, user_id: USER, name: "Smita Verma", network_status: "active" },
        { id: 104, user_id: USER, name: "Colleague", network_status: "active" },
      ],
      messages: [seedOutbound({ email_message_contacts: [{ contact_id: SMITA }, { contact_id: 104 }] })],
    });
    const result = await syncThreadReplies(USER);

    // The message still lands and is attributed to BOTH, but which of them owns
    // the sending address is genuinely unknowable, and a wrong contact_emails
    // row would misroute every future send.
    expect(result.ingested).toBe(1);
    expect(result.learnedAddresses).toBe(0);
    expect(db.tables.contact_emails.some((e) => e.email === REPLY_ADDR)).toBe(false);
    const stored = db.tables.email_messages.find((m) => m.gmail_message_id === "reply-1")!;
    const links = db.tables.email_message_contacts.filter((l) => l.email_message_id === stored.id);
    expect(links.map((l) => l.contact_id).sort()).toEqual([SMITA, 104]);
  });

  it("treats our own send-as alias on the thread as outbound, learning nothing", async () => {
    fake = createFakeGmail({
      pages: [[{ id: "alias-1", threadId: THREAD, from: "me@myalias.dev", to: SENT_ADDR, subject: "Re: hello", date: "Tue, 04 Aug 2026 17:20:00 +0000" }]],
    });
    db = createFakeSyncDb({
      gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com", send_as_aliases: ["me@myalias.dev"], modify_scope_granted: true }],
      contacts: [{ id: SMITA, user_id: USER, name: "Smita Verma", network_status: "prospect" }],
      contact_emails: [{ id: 1, contact_id: SMITA, email: SENT_ADDR, is_primary: true, source: "scraped" }],
      email_messages: [seedOutbound()],
      email_message_contacts: [{ email_message_id: 1, contact_id: SMITA }],
    });

    const result = await syncThreadReplies(USER);
    expect(result.ingested).toBe(1);
    expect(db.tables.email_messages.find((m) => m.gmail_message_id === "alias-1")!.direction).toBe("outbound");
    // Our own alias is not the contact's address, and our own send is not a reply.
    expect(result.learnedAddresses).toBe(0);
    expect(db.tables.contacts.find((c) => c.id === SMITA)!.network_status).toBe("prospect");
    expect(trackServer).not.toHaveBeenCalled();
  });

  it("does no work at all when the user has no threads yet", async () => {
    fake = createFakeGmail({ pages: [[REPLY]] });
    db = createFakeSyncDb({
      gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com", send_as_aliases: [] }],
      email_messages: [],
    });
    const result = await syncThreadReplies(USER);

    expect(result).toEqual({ ingested: 0, learnedAddresses: 0 });
    // Not one Gmail call: with nothing to match against, the sweep is pointless.
    expect(fake.state.listCalls).toEqual([]);
  });
});
