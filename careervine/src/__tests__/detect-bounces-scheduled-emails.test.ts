import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { mockServiceClientModule } from "./helpers/mock-supabase";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";

/**
 * CAR-220: a bounced scheduled email must not be a permanent poison row.
 *
 * `processScheduledEmails` refuses to send to an address that has bounced
 * (SendPolicyError 422 out of the shared tracked-send path) and releases the
 * claim back to 'pending', on the stated understanding that "detectBounces
 * cancels the row once the NDR lands". detectBounces wrote contact_emails,
 * email_follow_ups and email_follow_up_messages — never scheduled_emails — so
 * the row stayed due forever: every tick claimed it, refused it, and released
 * it again, with only a console.warn to show for it. The only exits were the
 * user cancelling or retrying by hand.
 *
 * 'cancelled' is in the table's CHECK constraint
 * (20260716200000_car134_scheduled_email_claim.sql:
 *  pending | sending | sent | cancelled | failed) and is the same terminal
 * status the user's own cancel writes.
 */

const USER = "user-1";
const OTHER_USER = "user-2";

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
  mockAnalyticsServerModule({ trackServer: async () => {}, checkCompaniesEmailedMilestone: async () => {} }),
);

import { detectBounces } from "@/lib/gmail";

const ndr = (failedRecipients: string) =>
  createFakeGmail({
    pages: [[
      {
        id: "ndr-1",
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        extraHeaders: { "X-Failed-Recipients": failedRecipients },
      },
    ]],
  });

const scheduledRow = (over: Record<string, unknown>) => ({
  user_id: USER,
  recipient_email: "john.doe@x.com",
  status: "pending",
  ...over,
});

const rowById = (id: number) => db.tables.scheduled_emails.find((r) => r.id === id)!;

beforeEach(() => {
  fake = ndr("John.Doe@X.com");
  db = createFakeSyncDb({
    contacts: [{ id: 7, user_id: USER, network_status: "prospect" }],
    contact_emails: [
      { id: 1, contact_id: 7, email: "john.doe@x.com", bounced_at: null, contacts: { user_id: USER } },
    ],
    email_follow_ups: [],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
    scheduled_emails: [
      // Stored as the user typed it. scheduled_emails.recipient_email has no
      // normalizing trigger (contact_emails does), so a case-sensitive match
      // would miss this row — and ILIKE cannot be used to paper over it,
      // because `_` and `%` are legal, common characters in an email local part.
      scheduledRow({ id: 11, recipient_email: "John.Doe@X.com" }),
      scheduledRow({ id: 12, recipient_email: "someone@else.com" }),
      // Claimed by a send driver. It may already be in Gmail's hands, so it is
      // the sweeper's to resolve, never this pass's.
      scheduledRow({ id: 13, status: "sending" }),
      // Already resolved.
      scheduledRow({ id: 14, status: "sent" }),
      // Another tenant's row for the same address.
      scheduledRow({ id: 15, user_id: OTHER_USER }),
    ],
  });
});

describe("detectBounces — pending scheduled emails to a bounced address", () => {
  it("cancels the poisoned row so it stops being re-claimed every tick", async () => {
    const result = await detectBounces(USER);

    expect(result.bounced).toEqual(["john.doe@x.com"]);
    expect(rowById(11).status).toBe("cancelled");
    expect(result.cancelledScheduled).toBe(1);
  });

  it("touches nothing else: other recipients, claimed rows, resolved rows, other tenants", async () => {
    await detectBounces(USER);

    expect(rowById(12).status).toBe("pending");
    expect(rowById(13).status).toBe("sending");
    expect(rowById(14).status).toBe("sent");
    expect(rowById(15).status).toBe("pending");
  });

  it("re-asserts 'pending' on the write so a row claimed mid-pass is not overwritten", async () => {
    await detectBounces(USER);

    const write = db
      .opsFor("scheduled_emails", "update")
      .find((op) => op.values?.status === "cancelled");
    expect(write).toBeDefined();
    expect(write!.filters).toContainEqual(["eq:status", "pending"]);
  });

  it("stays contact-scoped: an NDR for an address this user has no contact for cancels nothing", async () => {
    // detectBounces only touches addresses belonging to this user's contacts —
    // it cannot record bounced_at for anything else, so cancelling would leave
    // a row cancelled with no bounce marker anywhere to explain it. Such a row
    // is not poisoned either: the 422 refusal keys off contact_emails.bounced_at.
    fake = ndr("someone@else.com");

    const result = await detectBounces(USER);

    expect(result.bounced).toEqual([]);
    expect(result.cancelledScheduled).toBe(0);
    expect(rowById(12).status).toBe("pending");
  });
});
