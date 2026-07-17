import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CAR-153/R2.8 (deep-review finding): contact_emails.email is normalized to
 * lower(trim()) by a DB trigger, so the check-duplicate exact-email matcher
 * must normalize its input identically — a raw mixed-case scrape would
 * otherwise NEVER match and duplicate detection silently reports "no dupe".
 */

const eqCalls: Array<[string, unknown]> = [];

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }),
    },
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test chainable stub
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          if (table === "contact_emails") eqCalls.push([col, val]);
          return builder;
        },
        in: () => builder,
        or: () => builder,
        not: () => builder,
        limit: () => builder,
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return builder;
    },
  }),
}));

import { POST } from "@/app/api/contacts/check-duplicate/route";

function makeReq(body: Record<string, unknown>) {
  const url = "http://localhost:3000/api/contacts/check-duplicate";
  return {
    method: "POST",
    url,
    nextUrl: new URL(url),
    headers: new Headers(),
    json: async () => body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request stub
  } as any;
}

describe("check-duplicate — email matcher normalization (CAR-153/R2.8)", () => {
  beforeEach(() => {
    eqCalls.length = 0;
  });

  it("lowercases and trims the input before the exact .eq match", async () => {
    const res = await POST(makeReq({ email: " John.Doe@Company.COM " }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);

    const emailEq = eqCalls.find(([col]) => col === "email");
    expect(emailEq).toBeDefined();
    expect(emailEq![1]).toBe("john.doe@company.com");
  });
});
