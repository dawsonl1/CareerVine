import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mockServerClientModule, mockServiceClientModule } from "./helpers/mock-supabase";

/**
 * CAR-183: DELETE /api/gmail/templates/[id] used a bare `parseInt(id)`.
 *
 * parseInt is lenient, so "3abc" parsed to 3 and deleted a DIFFERENT, valid
 * template, while "abc" parsed to NaN, reached PostgREST as `id=eq.NaN`, and
 * surfaced a client input error as a 500 (plus a false `api_error` telemetry
 * event). `paramsSchema: idParamSchema` makes both a 400 before the handler
 * runs, so the id that reaches the query is always the id in the URL.
 */

const deletedIds: unknown[] = [];

// Shared typed factories (CAR-187), so a change to either client module's
// exports is a compile error here rather than an undefined at call time.
vi.mock("@/lib/supabase/server-client", () => mockServerClientModule());

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => ({
    from: () => {
      const b: Record<string, unknown> = {
        delete: () => b,
        eq: (column: string, value: unknown) => {
          if (column === "id") deletedIds.push(value);
          return b;
        },
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return b;
    },
  })),
);

import { DELETE } from "@/app/api/gmail/templates/[id]/route";

function del(id: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/gmail/templates/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
}

describe("DELETE /api/gmail/templates/[id] param validation (CAR-183)", () => {
  beforeEach(() => {
    deletedIds.length = 0;
  });

  it("deletes the requested template for a well-formed numeric id", async () => {
    const res = await del("3");

    expect(res.status).toBe(200);
    expect(deletedIds).toEqual([3]);
  });

  it("rejects a trailing-garbage id instead of deleting a different template", async () => {
    // The regression: parseInt("3abc") === 3, so this silently deleted #3.
    const res = await del("3abc");

    expect(res.status).toBe(400);
    expect(deletedIds).toEqual([]);
  });

  it("rejects a non-numeric id with a 400 rather than a 500 from Postgres", async () => {
    const res = await del("abc");

    expect(res.status).toBe(400);
    expect(deletedIds).toEqual([]);
  });

  it("rejects a negative id", async () => {
    const res = await del("-1");

    expect(res.status).toBe(400);
    expect(deletedIds).toEqual([]);
  });
});
