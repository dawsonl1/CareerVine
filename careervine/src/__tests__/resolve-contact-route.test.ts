import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-149 F48: resolve-contact validates the email at the query-schema
 * boundary and strips PostgREST structural metachars before the .or()
 * interpolation — without corrupting a real email (the domain dots must
 * survive or the eq match silently breaks).
 */

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }),
    },
  }),
}));

const orCalls: string[] = [];
vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test chainable stub
    const builder: any = {
      _table: "",
      from(t: string) {
        this._table = t;
        return this;
      },
      select() {
        return this;
      },
      eq() {
        return this;
      },
      or(expr: string) {
        orCalls.push(expr);
        return this;
      },
      not() {
        return this;
      },
      limit() {
        return this;
      },
      single() {
        // contact_emails lookup misses → falls through to the email_messages
        // .or() path, which is the one we care about.
        return this._table === "email_messages"
          ? Promise.resolve({ data: { matched_contact_id: 7 } })
          : Promise.resolve({ data: null });
      },
    };
    return builder;
  },
}));

import { GET } from "@/app/api/gmail/ai-write/resolve-contact/route";

function makeReq(email: string) {
  const url = new URL("http://localhost:3000/api/gmail/ai-write/resolve-contact");
  url.searchParams.set("email", email);
  return {
    method: "GET",
    url: url.toString(),
    nextUrl: url,
    headers: new Headers(),
    json: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request stub
  } as any;
}

describe("resolve-contact route (CAR-149 F48)", () => {
  beforeEach(() => {
    orCalls.length = 0;
  });

  it("resolves a valid email and preserves its dots in the .or() filter", async () => {
    const res = await GET(makeReq("john.doe@sub.example.com"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ contactId: 7 });
    // The email flows into .or() UNCHANGED (a valid email has no metachars) —
    // in particular the domain dots survive, so the eq match still works.
    expect(orCalls).toHaveLength(1);
    expect(orCalls[0]).toBe(
      "from_address.eq.john.doe@sub.example.com,to_addresses.cs.{john.doe@sub.example.com}",
    );
  });

  it("rejects non-email input (400) before any query runs", async () => {
    const res = await GET(makeReq("not-an-email"));
    expect(res.status).toBe(400);
    expect(orCalls).toHaveLength(0);
  });

  it("rejects an injection payload smuggled as the email (400)", async () => {
    const res = await GET(makeReq("a@b.com,user_id.neq.0"));
    expect(res.status).toBe(400);
    expect(orCalls).toHaveLength(0);
  });
});
