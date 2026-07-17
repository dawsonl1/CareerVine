import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * CAR-143 (R5.2/R5.1): POST /api/email-follow-ups is a storage chokepoint the
 * send cron trusts — a script-tag POST must store sanitized body_html, and a
 * CRLF-laced subject/recipient must be rejected at the boundary.
 */

let authedUser: Record<string, unknown> | null = { id: "u-1" };
const messageInserts: unknown[] = [];

vi.mock("@/lib/supabase/server-client", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authedUser }, error: null })) },
  })),
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: vi.fn(() => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {
        insert: (rows: unknown) => {
          if (table === "email_follow_up_messages") messageInserts.push(rows);
          return b;
        },
        select: () => b,
        eq: () => b,
        delete: () => b,
        single: async () => ({ data: { id: 7 }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return b;
    },
  })),
}));

import { POST } from "@/app/api/email-follow-ups/route";

function post(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/email-follow-ups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BASE = {
  contactId: 5,
  threadId: "thr-1",
  messageId: "msg-1",
  recipientEmail: "sam@example.com",
  contactName: "Sam",
  originalSubject: "Hello",
  originalSentAt: "2026-07-01T12:00:00Z",
  timezoneOffsetMinutes: 0,
};

describe("POST /api/email-follow-ups (CAR-143)", () => {
  beforeEach(() => {
    authedUser = { id: "u-1" };
    messageInserts.length = 0;
  });

  it("stores sanitized body_html when the payload carries a script tag", async () => {
    const res = await POST(
      post({
        ...BASE,
        followUps: [
          {
            subject: "Checking in",
            bodyHtml: '<p>Hi</p><script>fetch("https://evil")</script><p onclick="x()">there</p>',
            delayDays: 7,
          },
        ],
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    const rows = messageInserts[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const stored = rows[0].body_html as string;
    expect(stored).not.toContain("<script");
    expect(stored).not.toContain("onclick");
    expect(stored).toContain("<p>Hi</p>");
  });

  it("rejects a CRLF-laced follow-up subject", async () => {
    const res = await POST(
      post({
        ...BASE,
        followUps: [
          {
            subject: "Hi\r\nBcc: attacker@evil.com",
            bodyHtml: "<p>x</p>",
            delayDays: 7,
          },
        ],
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
    expect(messageInserts).toHaveLength(0);
  });

  it("rejects a CRLF-laced recipient email", async () => {
    const res = await POST(
      post({
        ...BASE,
        recipientEmail: "sam@example.com\nBcc: evil@evil.com",
        followUps: [{ subject: "Hi", bodyHtml: "<p>x</p>", delayDays: 7 }],
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(400);
    expect(messageInserts).toHaveLength(0);
  });
});
