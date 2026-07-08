import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The /api/gmail/send route is a thin wrapper over sendTrackedEmail(). Its
 * remaining job is translating SendPolicyError into the right HTTP status
 * (cap → 429, bounce → 422) and returning the message ids on success. We drive
 * the REAL sendTrackedEmail (mocking only its DB/Gmail deps) so the route
 * catches the genuine error class — a regression that dropped the mapping
 * would surface as a generic 500 and fail these tests.
 */

const state = { sentToday: 0, emailRows: [] as Array<{ contact_id: number; source: string; bounced_at: string | null }> };

function makeBuilder(table: string) {
  let op: "select" | "upsert" | "insert" = "select";
  const resolveResult = () => {
    if (op === "upsert" || op === "insert") return { error: null };
    if (table === "email_messages") return { count: state.sentToday };
    if (table === "contact_emails") return { data: state.emailRows };
    return { data: [] };
  };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "in", "limit", "order"]) chain[m] = () => chain;
  chain.upsert = () => { op = "upsert"; return chain; };
  chain.insert = () => { op = "insert"; return chain; };
  chain.then = (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(resolveResult()).then(onF, onR);
  return chain;
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({ from: (t: string) => makeBuilder(t) }),
}));
vi.mock("@/lib/gmail", () => ({
  sendEmail: async () => ({ messageId: "m1", threadId: "t1" }),
  getConnection: async () => ({ gmail_address: "me@example.com" }),
}));
vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/gmail/send/route";

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/gmail/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const VALID = { to: "jane@corp.com", subject: "Hi", bodyHtml: "<p>Hi</p>" };

beforeEach(() => {
  state.sentToday = 0;
  state.emailRows = [];
});

describe("/api/gmail/send", () => {
  it("maps the daily-cap SendPolicyError to HTTP 429", async () => {
    state.sentToday = 100;
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Daily send limit/);
  });

  it("maps the bounce SendPolicyError to HTTP 422", async () => {
    state.emailRows = [{ contact_id: 7, source: "verified", bounced_at: "2026-01-01T00:00:00Z" }];
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/bounced/);
  });

  it("returns message + thread ids on a normal send", async () => {
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, messageId: "m1", threadId: "t1" });
  });

  it("rejects a body missing the recipient with 400", async () => {
    const res = await POST(makeReq({ subject: "no recipient" }));
    expect(res.status).toBe(400);
  });
});
