import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createFakeGmail, createFakeSyncDb } from "./helpers/fake-gmail";

/**
 * CAR-153/R2.8: contact_emails.email is normalized to lower(trim()) by a DB
 * trigger, so every matcher must be an exact `.eq` on the lowercased input —
 * the unescaped `.ilike` (whose _ / % wildcards could cross-match) is banned.
 *
 * Pinned here:
 *   1. activateContactByEmail matches with .eq on the lowercased address and
 *      activates the prospect.
 *   2. detectBounces marks the stored (normalized) row for a mixed-case NDR
 *      recipient like John.Doe@X.com.
 *   3. Source scan: no .ilike remains on any contact_emails query.
 */

const USER = "user-1";

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

import { activateContactByEmail, detectBounces } from "@/lib/gmail";

beforeEach(() => {
  fake = createFakeGmail();
  db = createFakeSyncDb({
    contacts: [{ id: 7, user_id: USER, network_status: "prospect" }],
    // Stored rows are normalized (lowercase) — that's what the trigger guarantees.
    contact_emails: [
      { id: 1, contact_id: 7, email: "john.doe@x.com", bounced_at: null, contacts: { user_id: USER } },
    ],
    email_follow_ups: [],
    gmail_connections: [{ user_id: USER, gmail_address: "me@gmail.com" }],
  });
});

describe("activateContactByEmail", () => {
  it("matches a mixed-case input against the normalized column with .eq (no ILIKE)", async () => {
    await activateContactByEmail(USER, " John.Doe@X.COM ");

    const selects = db.opsFor("contact_emails", "select");
    expect(selects).toHaveLength(1);
    expect(selects[0].filters).toContainEqual(["eq:email", "john.doe@x.com"]);
    expect(db.tables.contacts[0].network_status).toBe("active");
  });
});

describe("detectBounces", () => {
  it("marks the stored row bounced for a mixed-case X-Failed-Recipients address", async () => {
    fake = createFakeGmail({
      pages: [[
        {
          id: "ndr-1",
          from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          subject: "Delivery Status Notification (Failure)",
          extraHeaders: { "X-Failed-Recipients": "John.Doe@X.com" },
        },
      ]],
    });

    const result = await detectBounces(USER);

    expect(result.bounced).toEqual(["john.doe@x.com"]);
    expect(db.tables.contact_emails[0].bounced_at).not.toBeNull();
  });
});

describe("contact_emails matcher hygiene", () => {
  it("no .ilike matcher remains on any contact_emails query in src", () => {
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__tests__") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = fs.readFileSync(full, "utf8");
          // Examine the builder chain following each contact_emails query;
          // chains end at the statement's terminating semicolon.
          let idx = src.indexOf('from("contact_emails")');
          while (idx !== -1) {
            const chainEnd = src.indexOf(";", idx);
            const chain = src.slice(idx, chainEnd === -1 ? undefined : chainEnd);
            if (chain.includes(".ilike(")) offenders.push(path.relative(root, full));
            idx = src.indexOf('from("contact_emails")', idx + 1);
          }
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});
