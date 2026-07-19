import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";

/**
 * CAR-153: fixture-driven tests for the REAL `syncEmailsForContact` loop —
 * the fake Gmail client (multi-page list + parameterized message metadata)
 * and the in-memory DB double drive it end-to-end through persistence and
 * attribution.
 *
 * Pinned here:
 *   1. Direction classification is alias-aware (R2.5): From any own address
 *      (primary OR send-as alias, any casing) → outbound; alias-sent mail
 *      never activates a prospect and never fires reply_received.
 *   2. The resume point is the completion-gated watermark (R2.2):
 *      contacts.email_synced_through, advanced only when the pagination loop
 *      drains every page — NEVER derived from max(cached message date), which
 *      self-hides holes because Gmail lists newest-first.
 *   3. Date parsing (invalid → null) and safe-field-only updates on existing
 *      rows (is_read / is_trashed / is_hidden are user-owned).
 *   4. withRetry retries Gmail's 403-shaped rate limits but not other 403s.
 */

const USER = "user-1";
const CONTACT = 7;

let fake = createFakeGmail();
let db = createFakeSyncDb();
const trackSpy = vi.fn();

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
  trackServer: (...args: unknown[]) => {
    trackSpy(...args);
    return Promise.resolve();
  },
  checkCompaniesEmailedMilestone: async () => {},
}));

import { syncEmailsForContact, syncAllContactEmails, fetchSendAsAliases, withRetry, checkForReplyInThread } from "@/lib/gmail";

function seedDb(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  db = createFakeSyncDb({
    contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "prospect" }],
    email_messages: [],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    ...overrides,
  });
}

function afterEpochOf(q: string): number {
  const m = q.match(/after:(\d+)/);
  expect(m, `query missing after: — ${q}`).toBeTruthy();
  return parseInt(m![1], 10);
}

beforeEach(() => {
  trackSpy.mockClear();
  seedDb();
  fake = createFakeGmail();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncEmailsForContact — direction classification (R2.5)", () => {
  it("classifies From primary/alias (any casing) as outbound, others as inbound", async () => {
    fake = createFakeGmail({
      pages: [[
        { id: "m-in", threadId: "t1", from: "Jane <jane@corp.com>", to: "me@gmail.com", subject: "hi", date: "Mon, 13 Jul 2026 10:00:00 -0600" },
        { id: "m-out", threadId: "t1", from: "Me <Me@Gmail.COM>", to: "jane@corp.com", subject: "re", date: "Mon, 13 Jul 2026 11:00:00 -0600" },
        { id: "m-alias", threadId: "t2", from: "Me <me@myalias.dev>", to: "jane@corp.com", subject: "outreach", date: "Mon, 13 Jul 2026 12:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com", "me@myalias.dev"]);

    const byId = Object.fromEntries(db.tables.email_messages.map((r) => [r.gmail_message_id, r]));
    expect(byId["m-in"].direction).toBe("inbound");
    expect(byId["m-out"].direction).toBe("outbound");
    expect(byId["m-alias"].direction).toBe("outbound");
  });

  it("alias-sent mail never activates the contact and never fires reply_received", async () => {
    fake = createFakeGmail({
      pages: [[
        { id: "m-alias", threadId: "t1", from: "me@myalias.dev", to: "jane@corp.com", subject: "outreach", date: "Mon, 13 Jul 2026 12:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com", "me@myalias.dev"]);

    expect(db.tables.contacts[0].network_status).toBe("prospect");
    const statusUpdates = db.opsFor("contacts", "update").filter((o) => o.values && "network_status" in o.values);
    expect(statusUpdates).toHaveLength(0);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("a genuine inbound reply on our thread activates the contact and fires reply_received", async () => {
    seedDb({
      contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "prospect" }],
      email_messages: [
        { user_id: USER, gmail_message_id: "m-sent", thread_id: "t1", direction: "outbound", ai_assisted: true },
      ],
    });
    fake = createFakeGmail({
      pages: [[
        { id: "m-reply", threadId: "t1", from: "jane@corp.com", to: "me@gmail.com", subject: "re", date: "Mon, 13 Jul 2026 12:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(db.tables.contacts[0].network_status).toBe("active");
    expect(trackSpy).toHaveBeenCalledWith(USER, "reply_received", { ai_assisted: true });
  });
});

describe("syncEmailsForContact — parsing and safe updates", () => {
  it("parses valid Date headers to ISO and invalid ones to null", async () => {
    fake = createFakeGmail({
      pages: [[
        { id: "m-good", from: "jane@corp.com", to: "me@gmail.com", date: "Mon, 13 Jul 2026 10:00:00 -0600" },
        { id: "m-bad", from: "jane@corp.com", to: "me@gmail.com", date: "not a date at all" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    const byId = Object.fromEntries(db.tables.email_messages.map((r) => [r.gmail_message_id, r]));
    expect(byId["m-good"].date).toBe(new Date("Mon, 13 Jul 2026 10:00:00 -0600").toISOString());
    expect(byId["m-bad"].date).toBeNull();
  });

  it("updates only safe fields on existing rows — never is_read / is_trashed / is_hidden", async () => {
    seedDb({
      contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "active" }],
      email_messages: [
        { user_id: USER, gmail_message_id: "m1", thread_id: "t1", direction: "inbound", is_read: false, is_trashed: true, is_hidden: true, subject: "old" },
      ],
    });
    fake = createFakeGmail({
      pages: [[
        { id: "m1", threadId: "t1", from: "jane@corp.com", to: "me@gmail.com", subject: "new subject", labelIds: ["INBOX"], date: "Mon, 13 Jul 2026 10:00:00 -0600" },
      ]],
    });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    const updates = db.opsFor("email_messages", "update");
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(Object.keys(u.values!).sort()).toEqual(["label_ids", "snippet", "subject", "thread_id"]);
    }
    const row = db.tables.email_messages.find((r) => r.gmail_message_id === "m1")!;
    expect(row.subject).toBe("new subject");
    expect(row.is_read).toBe(false);
    expect(row.is_trashed).toBe(true);
    expect(row.is_hidden).toBe(true);
  });
});

describe("syncEmailsForContact — completion-gated watermark (R2.2)", () => {
  it("derives afterEpoch from the watermark (minus 1-day overlap), not from cached message dates", async () => {
    const watermark = "2026-07-01T00:00:00.000Z";
    seedDb({
      contacts: [{ id: CONTACT, user_id: USER, email_synced_through: watermark, network_status: "active" }],
      email_messages: [
        // A fresh cached message — the legacy max(date) derivation would
        // resume from here and permanently skip the uncached older span.
        { user_id: USER, gmail_message_id: "m-cached", matched_contact_id: CONTACT, date: new Date(Date.now() - 3600_000).toISOString(), direction: "inbound" },
      ],
    });
    fake = createFakeGmail({ pages: [[]] });

    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    const expected = Math.floor((new Date(watermark).getTime() - 86400_000) / 1000);
    expect(afterEpochOf(fake.state.listCalls[0].q)).toBe(expected);
  });

  it("falls back to the sinceDays window when no watermark exists — even with cached messages", async () => {
    seedDb({
      contacts: [{ id: CONTACT, user_id: USER, email_synced_through: null, network_status: "active" }],
      email_messages: [
        { user_id: USER, gmail_message_id: "m-cached", matched_contact_id: CONTACT, date: new Date(Date.now() - 3600_000).toISOString(), direction: "inbound" },
      ],
    });
    fake = createFakeGmail({ pages: [[]] });

    const before = Date.now();
    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"], 90);
    const after = Date.now();

    const epoch = afterEpochOf(fake.state.listCalls[0].q);
    expect(epoch).toBeGreaterThanOrEqual(Math.floor((before - 90 * 86400_000) / 1000));
    expect(epoch).toBeLessThanOrEqual(Math.floor((after - 90 * 86400_000) / 1000));
  });

  it("a throw mid-pagination leaves the watermark untouched; the next run re-covers the same span; a completed run advances it", async () => {
    const watermark = "2026-07-01T00:00:00.000Z";
    const expectedEpoch = Math.floor((new Date(watermark).getTime() - 86400_000) / 1000);
    seedDb({
      contacts: [{ id: CONTACT, user_id: USER, email_synced_through: watermark, network_status: "active" }],
    });
    fake = createFakeGmail({
      pages: [
        [{ id: "m-new", threadId: "t9", from: "jane@corp.com", to: "me@gmail.com", subject: "page1", date: "Mon, 06 Jul 2026 10:00:00 -0600" }],
        [{ id: "m-old", threadId: "t9", from: "jane@corp.com", to: "me@gmail.com", subject: "page2", date: "Thu, 02 Jul 2026 10:00:00 -0600" }],
      ],
      failOnListPages: new Set([1]),
    });

    await expect(
      syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"])
    ).rejects.toThrow();

    // Page 1 was cached, but the watermark did NOT advance.
    expect(db.tables.email_messages.map((r) => r.gmail_message_id)).toEqual(["m-new"]);
    expect(db.tables.contacts[0].email_synced_through).toBe(watermark);
    const watermarkWrites = db.opsFor("contacts", "update").filter((o) => o.values && "email_synced_through" in o.values);
    expect(watermarkWrites).toHaveLength(0);

    // Second run: same afterEpoch (re-covers the interrupted span), then
    // completes. Coverage note (deep-review): this re-cover is SEQUENTIAL, so
    // the existingIds pre-filter already skips the cached row and the
    // ignoreDuplicates upsert's conflict path never fires here — the
    // CONCURRENT dedupe guarantee (two overlapping syncs racing past the
    // pre-filter, resolved by the unique constraint + RETURNING-only-inserted,
    // CAR-58) rests on the DB constraint and is not reproducible with this
    // single-threaded fake.
    fake.options.failOnListPages!.clear();
    const runStart = Date.now();
    await syncEmailsForContact(USER, CONTACT, ["jane@corp.com"], ["me@gmail.com"]);

    expect(afterEpochOf(fake.state.listCalls[0].q)).toBe(expectedEpoch);
    expect(afterEpochOf(fake.state.listCalls[fake.state.listCalls.length - 2].q)).toBe(expectedEpoch);

    // Both pages now cached, no duplicates from the re-covered page.
    expect(db.tables.email_messages.map((r) => r.gmail_message_id).sort()).toEqual(["m-new", "m-old"]);

    // Watermark advanced to the completed run's start.
    const stamped = db.tables.contacts[0].email_synced_through as string;
    expect(new Date(stamped).getTime()).toBeGreaterThanOrEqual(runStart - 1000);
  });
});

describe("withRetry — Gmail 403 rate limits (R2.2)", () => {
  it("retries 403 rateLimitExceeded and succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withRetry(async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("rate limited"), {
          code: 403,
          errors: [{ reason: "rateLimitExceeded" }],
        });
      }
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("retries the googleapis response-body 403 shape (userRateLimitExceeded)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withRetry(async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error("rate limited"), {
          response: { status: 403, data: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } },
        });
      }
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry a non-rate-limit 403 (missing scope)", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw Object.assign(new Error("forbidden"), {
          code: 403,
          errors: [{ reason: "insufficientPermissions" }],
        });
      })
    ).rejects.toThrow("forbidden");
    expect(calls).toBe(1);
  });
});

describe("syncAllContactEmails — totalSynced under concurrent completion", () => {
  it("counts every contact's rows when pooled syncs overlap (no lost update)", async () => {
    // Pins the `x += await f()` lost-update race: compound assignment reads
    // the accumulator BEFORE the await suspends, so overlapping tasks would
    // clobber each other's additions (3 contacts x 2 rows -> 2, not 6).
    seedDb({
      contacts: [1, 2, 3].map((id) => ({
        id,
        user_id: USER,
        email_synced_through: null,
        network_status: "active",
        contact_emails: [{ email: `p${id}@x.com` }],
      })),
      gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => { releaseGate = r; });
    fake = createFakeGmail({
      pages: [[
        { id: "m1", threadId: "t1", from: "jane@corp.com", to: "me@gmail.com", date: "Mon, 13 Jul 2026 10:00:00 -0600" },
        { id: "m2", threadId: "t1", from: "Me <me@gmail.com>", to: "jane@corp.com", date: "Mon, 13 Jul 2026 11:00:00 -0600" },
      ]],
      listGate: () => gate,
    });

    const resultPromise = syncAllContactEmails(USER, 90);
    // Let all three pooled tasks launch and block on the gate together, so
    // their accumulator updates genuinely interleave.
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.state.inFlightListCalls).toBe(3);
    releaseGate();
    const result = await resultPromise;

    expect(result.processedContacts).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(result.totalSynced).toBe(6);
  });
});

describe("checkForReplyInThread — alias-aware self-filter (R2.5)", () => {
  it("does not count the user's own alias-sent thread message as a reply", async () => {
    seedDb({
      contacts: [],
      email_messages: [],
      gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com", send_as_aliases: ["me@myalias.dev"] }],
    });
    fake = createFakeGmail({
      threads: { t1: [
        { from: "Me <me@gmail.com>" },
        { from: "Me <Me@MyAlias.dev>" },
      ] },
    });

    await expect(checkForReplyInThread(USER, "t1", "2026-07-01T00:00:00Z")).resolves.toBe(false);
  });

  it("still detects a genuine reply from anyone else", async () => {
    seedDb({
      contacts: [],
      email_messages: [],
      gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com", send_as_aliases: ["me@myalias.dev"] }],
    });
    fake = createFakeGmail({
      threads: { t1: [
        { from: "me@gmail.com" },
        { from: "jane@corp.com" },
      ] },
    });

    await expect(checkForReplyInThread(USER, "t1", "2026-07-01T00:00:00Z")).resolves.toBe(true);
  });

  it("does not count an NDR (mailer-daemon) in the thread as a reply", async () => {
    // A bounce is a delivery failure, not the contact writing back —
    // detectBounces owns NDRs (bounced_at + cancelled_bounce).
    seedDb({
      contacts: [],
      email_messages: [],
      gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    });
    fake = createFakeGmail({
      threads: { t1: [
        { from: "me@gmail.com" },
        { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" },
      ] },
    });

    await expect(checkForReplyInThread(USER, "t1", "2026-07-01T00:00:00Z")).resolves.toBe(false);
  });
});

describe("fetchSendAsAliases", () => {
  it("returns the lowercased, trimmed alias list", async () => {
    fake = createFakeGmail({ sendAsAliases: [" Me@Gmail.com ", "Alias@X.dev", ""] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake client stands in for gmail_v1.Gmail
    await expect(fetchSendAsAliases(fake.gmail as any)).resolves.toEqual(["me@gmail.com", "alias@x.dev"]);
  });
});
