import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-221: GET /api/gmail/inbox must not read a whole user-owned table.
 *
 * PostgREST caps a response at 1000 rows and truncates SILENTLY — no error, no
 * signal. The route used to build its id → name map from an unpaginated
 * `.from("contacts").select("id, name").eq("user_id", ...)`, so a user past
 * 1000 contacts got names for some and bare email addresses for the rest. It
 * reproduced in production: 2005 contacts, 1000 returned, and every one of the
 * 1005 dropped rows was a prospect, so mail to prospects rendered as raw
 * addresses while saved contacts kept their names.
 *
 * The fake below models the cap the way PostgREST applies it: filters first,
 * then truncate. A query scoped by id therefore stays intact while a
 * whole-table read loses its tail, which is exactly what separates the fix
 * from the bug.
 */

const CAP = 1000;
const USER = "u-1";
/** Referenced by the seeded email, and deliberately past the cap. */
const FAR_CONTACT = 1500;

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
/** Every select the route issued, for the structural assertion. */
let queries: Array<{ table: string; ins: string[] }> = [];

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const ins: Array<[string, unknown[]]> = [];
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "not", "is", "gte"]) chain[m] = () => chain;
      chain.eq = (col: string, val: unknown) => (eqs.push([col, val]), chain);
      chain.in = (col: string, vals: unknown[]) => (ins.push([col, vals]), chain);
      (chain as { then?: unknown }).then = (resolve: (v: unknown) => void) => {
        queries.push({ table, ins: ins.map(([c]) => c) });
        let rows = tables[table] ?? [];
        for (const [col, val] of eqs) {
          // Embedded filters (contacts.user_id) are ownership scoping the fake
          // seeds as already-scoped; only flat columns are matched here.
          if (col.includes(".")) continue;
          rows = rows.filter((r) => r[col] === val);
        }
        for (const [col, vals] of ins) rows = rows.filter((r) => vals.includes(r[col]));
        // PostgREST truncates AFTER filtering, and says nothing about it.
        resolve({ data: rows.slice(0, CAP), error: null });
      };
      return chain;
    },
  })),
);

vi.mock("@/lib/gmail-send-core", () => ({
  getConnection: vi.fn(async () => ({ gmail_address: "me@gmail.com", send_as_aliases: [] })),
}));

vi.mock("@/lib/supabase/server-client", () => mockServerClientModule({ user: () => ({ id: USER }) }));

import { mockServerClientModule, mockServiceClientModule } from "./helpers/mock-supabase";
import { GET } from "@/app/api/gmail/inbox/route";

function makeRequest() {
  const url = "http://localhost:3000/api/gmail/inbox";
  return { method: "GET", nextUrl: new URL(url), url, headers: new Headers(), json: async () => ({}) } as never;
}

async function call() {
  const res = await GET(makeRequest(), { params: Promise.resolve({}) });
  return { status: res.status, data: await res.json() };
}

beforeEach(() => {
  queries = [];
  for (const k of Object.keys(tables)) delete tables[k];

  // A contacts table past the cap. The contact our mail is attributed to sits
  // beyond row 1000, exactly like Dawson's later-imported prospects.
  tables.contacts = Array.from({ length: 2005 }, (_, i) => ({
    id: i + 1,
    user_id: USER,
    name: i + 1 === FAR_CONTACT ? "Derek Egan" : `Contact ${i + 1}`,
  }));
  tables.contact_companies = [];
  tables.contact_emails = [];
  tables.scheduled_emails = [];
  tables.email_follow_ups = [];
  tables.calendar_events = [];
  tables.email_messages = [
    {
      id: 1,
      user_id: USER,
      gmail_message_id: "m1",
      thread_id: "t1",
      subject: "Intro",
      date: "2026-08-04T12:00:00Z",
      direction: "outbound",
      matched_contact_id: FAR_CONTACT,
      is_trashed: false,
      is_hidden: false,
      email_message_contacts: [{ contact_id: FAR_CONTACT }],
    },
  ];
});

describe("GET /api/gmail/inbox — no whole-table reads (CAR-221)", () => {
  it("names a contact that sits past the 1000-row cap", async () => {
    const { status, data } = await call();
    expect(status).toBe(200);
    // The bug rendered this row as a bare email address because the name was
    // missing from the truncated map.
    expect(data.contactMap[FAR_CONTACT]).toBe("Derek Egan");
    expect(data.contactDetails[FAR_CONTACT]?.name).toBe("Derek Egan");
  });

  it("never selects the contacts table without scoping it to referenced ids", async () => {
    await call();
    const contactReads = queries.filter((q) => q.table === "contacts");
    expect(contactReads.length).toBeGreaterThan(0);
    for (const q of contactReads) expect(q.ins).toContain("id");
  });

  it("scopes the calendar-events read to the threads on screen", async () => {
    await call();
    const calendarReads = queries.filter((q) => q.table === "calendar_events");
    for (const q of calendarReads) expect(q.ins).toContain("source_gmail_thread_id");
  });

  it("returns a contactMap covering every contact the payload references", async () => {
    const { data } = await call();
    for (const e of data.emails) {
      for (const id of e.contact_ids) expect(data.contactMap[id]).toBeTruthy();
    }
  });
});
