/**
 * Re-saving a contact from the extension re-points where mail goes (CAR-279).
 *
 * The route used to insert a newly typed address with `is_primary: !hasPrimary`,
 * so a re-add with a better address landed as SECONDARY and every outreach
 * surface kept using the old one. The whole point of typing an address into the
 * extension a second time is that it is the address now.
 *
 * Drives the real POST handler with extension auth and company resolution
 * mocked, against an in-memory `contact_emails` table — the assertion is on the
 * rows the contact is left holding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FakeEmailTable, type FakeQuery } from "./helpers/fake-contact-emails";

const CONTACT_ID = 100;
let table: FakeEmailTable;
let calls: FakeQuery[] = [];

function makeBuilder(name: string) {
  const q: FakeQuery = { table: name, op: "select", filters: [] };
  calls.push(q);
  const resolve = () => {
    const fromTable = table.apply(q);
    if (fromTable) return fromTable;
    // The only other read the update path makes that must return a row: the
    // duplicate probe, which is what sends this import down the update branch.
    if (q.table === "contacts" && q.op === "select") return { data: { id: CONTACT_ID }, error: null };
    return { data: null, error: null };
  };
  const builder: Record<string, unknown> = {};
  const chain = (method: string) => (...args: unknown[]) => {
    q.filters.push({ method, args });
    return builder;
  };
  Object.assign(builder, {
    select: chain("select"), eq: chain("eq"), is: chain("is"), in: chain("in"), or: chain("or"),
    order: chain("order"), limit: chain("limit"),
    insert(p: unknown) { q.op = "insert"; q.payload = p; return builder; },
    update(p: unknown) { q.op = "update"; q.payload = p; return builder; },
    delete() { q.op = "delete"; return builder; },
    async single() { return resolve(); },
    async maybeSingle() { return resolve(); },
    then(f: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(f); },
  });
  return builder;
}

vi.mock("@/lib/extension-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-auth")>();
  return {
    ...actual,
    getExtensionAuth: vi.fn(async () => ({
      user: { id: "user-1" },
      supabase: { from: (t: string) => makeBuilder(t) },
    })),
  };
});

// Side effects that have nothing to do with which address is primary.
vi.mock("@/lib/apify/scrape-service", () => ({ triggerEnrichOnSave: vi.fn(async () => ({ status: "skipped" })) }));
vi.mock("@/lib/gmail", () => ({ backfillEmailsForContact: vi.fn(async () => {}) }));
vi.mock("@/lib/contact-email-history", () => ({ syncContactEmailHistoryIfPaid: vi.fn(async () => {}) }));
vi.mock("@/lib/analytics/server", () => mockAnalyticsServerModule());
vi.mock("@/lib/onboarding/extension-server", () => ({ advanceExtensionOnboarding: vi.fn(async () => {}) }));
vi.mock("@/lib/company-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/company-helpers")>();
  return {
    ...actual,
    findOrCreateCompany: vi.fn(async () => ({ id: 1, name: "Acme", possible_duplicate_of: null })),
    findOrCreateLocation: vi.fn(async () => ({ id: 1 })),
    ensureCompanyLocation: vi.fn(async () => {}),
    ensureCompanyTargets: vi.fn(async () => 0),
  };
});
vi.mock("@/lib/data/contacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data/contacts")>();
  // Only the contacts-table writes are stubbed; the email functions under test
  // are the real ones, running against the fake table.
  return { ...actual, createContact: vi.fn(async () => ({ id: CONTACT_ID })), updateContact: vi.fn(async () => ({ id: CONTACT_ID })) };
});

import { NextRequest } from "next/server";
import { mockAnalyticsServerModule } from "./helpers/mock-analytics";
import { POST } from "@/app/api/contacts/import/route";

function reSave(email: string) {
  return new NextRequest("https://www.careervine.app/api/contacts/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      profileData: {
        name: "Jane Doe",
        linkedin_url: "https://linkedin.com/in/jane",
        contactInfo: { email },
      },
    }),
  });
}

describe("POST /api/contacts/import — the re-added address becomes primary (CAR-279)", () => {
  beforeEach(() => {
    table = new FakeEmailTable();
    calls = [];
  });

  it("promotes a different address typed on a re-save", async () => {
    table.seed(CONTACT_ID, [{ email: "old@acme.com", is_primary: true }]);

    const res = await POST(reSave("new@acme.com"));

    expect(res.status).toBe(200);
    expect(table.primaryOf(CONTACT_ID)?.email).toBe("new@acme.com");
    expect(table.of(CONTACT_ID).filter((r) => r.is_primary)).toHaveLength(1);
  });

  it("keeps the displaced address on the contact", async () => {
    table.seed(CONTACT_ID, [{ email: "old@acme.com", is_primary: true }]);

    await POST(reSave("new@acme.com"));

    expect(table.addressesOf(CONTACT_ID).sort()).toEqual(["new@acme.com", "old@acme.com"]);
  });

  it("drops the displaced address when it had bounced", async () => {
    table.seed(CONTACT_ID, [{ email: "dead@acme.com", is_primary: true, bounced_at: "2026-07-01T00:00:00Z" }]);

    await POST(reSave("new@acme.com"));

    expect(table.addressesOf(CONTACT_ID)).toEqual(["new@acme.com"]);
  });

  it("promotes an address already on the contact rather than duplicating it", async () => {
    table.seed(CONTACT_ID, [
      { email: "work@acme.com", is_primary: true },
      { email: "personal@gmail.com" },
    ]);

    await POST(reSave("personal@gmail.com"));

    expect(table.of(CONTACT_ID)).toHaveLength(2);
    expect(table.primaryOf(CONTACT_ID)?.email).toBe("personal@gmail.com");
  });

  it("still stores the first address when the contact had none", async () => {
    const res = await POST(reSave("first@acme.com"));

    expect(res.status).toBe(200);
    expect(table.primaryOf(CONTACT_ID)?.email).toBe("first@acme.com");
  });

  it("rejects a malformed address without touching what is on file", async () => {
    table.seed(CONTACT_ID, [{ email: "old@acme.com", is_primary: true }]);

    await POST(reSave("not-an-email"));

    expect(table.addressesOf(CONTACT_ID)).toEqual(["old@acme.com"]);
    expect(table.primaryOf(CONTACT_ID)?.email).toBe("old@acme.com");
  });

  it("does not fail the import when the address will not store", async () => {
    // Best-effort, as before: the rest of the profile still saves.
    table.seed(CONTACT_ID, [{ email: "old@acme.com", is_primary: true }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(table, "apply").mockImplementation((q) =>
      q.table === "contact_emails" && q.op === "insert"
        ? { data: null, error: { message: "boom" } }
        : undefined,
    );

    const res = await POST(reSave("new@acme.com"));

    expect(res.status).toBe(200);
    warn.mockRestore();
    vi.restoreAllMocks();
  });
});
