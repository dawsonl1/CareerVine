import { describe, it, expect, vi } from "vitest";

// CAR-148 (F11) — the import route now validates profileData at the wire. This
// exercises the REAL POST handler: a malformed profileData is rejected 400
// before the handler runs. Extension auth is mocked so the request reaches the
// body-validation stage; the malformed body then short-circuits with a 400.

vi.mock("@/lib/extension-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-auth")>();
  return {
    ...actual,
    getExtensionAuth: vi.fn(async () => ({
      user: { id: "user-1" },
      // Minimal chainable client — only the fire-and-forget last-seen stamp
      // might touch it, and only when a Bearer header is present (it isn't).
      supabase: {
        from: () => ({
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }),
      },
    })),
  };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/contacts/import/route";

function makeReq(body: unknown) {
  return new NextRequest("https://www.careervine.app/api/contacts/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/contacts/import — wire validation", () => {
  it("rejects profileData whose experience is not an array (400)", async () => {
    const res = await POST(makeReq({ profileData: { experience: "not-an-array" } }));
    expect(res.status).toBe(400);
  });

  it("rejects profileData with a scalar location (400)", async () => {
    const res = await POST(makeReq({ profileData: { location: "USA" } }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-object profileData (400)", async () => {
    const res = await POST(makeReq({ profileData: 123 }));
    expect(res.status).toBe(400);
  });

  it("rejects a body missing profileData (400)", async () => {
    const res = await POST(makeReq({ photoUrl: "https://example.com/a.jpg" }));
    expect(res.status).toBe(400);
  });
});
