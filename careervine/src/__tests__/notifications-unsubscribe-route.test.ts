import { describe, it, expect, vi, beforeEach } from "vitest";
import { signUnsubscribeToken } from "@/lib/notify/tokens";

/**
 * Unauthenticated one-click unsubscribe route (CAR-105). A valid HMAC token flips
 * followup_nudges_enabled to false via the service client; anything unverifiable
 * is a 400 and touches nothing.
 */

const updates: { patch: Record<string, unknown>; id: unknown }[] = [];
let updateError: unknown = null;

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: () => {
      let capturedPatch: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        update: (patch: Record<string, unknown>) => {
          capturedPatch = patch;
          return b;
        },
        eq: (_col: string, id: unknown) => {
          updates.push({ patch: capturedPatch, id });
          return Promise.resolve({ error: updateError });
        },
      };
      return b;
    },
  }),
}));

import { GET, POST } from "@/app/api/notifications/unsubscribe/route";

function req(token?: string) {
  const url = token
    ? `https://www.careervine.app/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`
    : "https://www.careervine.app/api/notifications/unsubscribe";
  return { url } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  updateError = null;
  process.env.NUDGE_UNSUBSCRIBE_SECRET = "test-secret-value";
});

describe("POST /api/notifications/unsubscribe", () => {
  it("disables nudges for a valid token", async () => {
    const token = signUnsubscribeToken("user-77", "followup_nudges");
    const res = await POST(req(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(updates).toEqual([{ patch: { followup_nudges_enabled: false }, id: "user-77" }]);
  });

  it("400s an invalid token and writes nothing", async () => {
    const res = await POST(req("garbage.token.value"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false });
    expect(updates).toHaveLength(0);
  });

  it("400s a missing token", async () => {
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("400s when the DB write errors (nothing silently 'succeeds')", async () => {
    updateError = { message: "boom" };
    const token = signUnsubscribeToken("user-77", "followup_nudges");
    const res = await POST(req(token));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false });
  });
});

describe("GET /api/notifications/unsubscribe", () => {
  it("renders a success confirmation page for a valid token", async () => {
    const token = signUnsubscribeToken("user-77", "followup_nudges");
    const res = await GET(req(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("You're unsubscribed");
    expect(updates).toHaveLength(1);
  });

  it("renders an expired-link page (400) for an invalid token", async () => {
    const res = await GET(req("nope"));
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Link expired");
    expect(updates).toHaveLength(0);
  });
});
