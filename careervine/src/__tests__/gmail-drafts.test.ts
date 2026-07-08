import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the shared MIME builder and the Gmail draft path (plan 26).
 * createDraft must reuse the exact MIME composition sendEmail uses so a
 * draft, once opened in Gmail, is byte-identical to what a send would be.
 */

// ── googleapis mock ────────────────────────────────────────────────────

const draftCreateCalls: Array<Record<string, unknown>> = [];

vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: {
        drafts: {
          create: async (args: Record<string, unknown>) => {
            draftCreateCalls.push(args);
            return { data: { id: "draft-1", message: { id: "msg-1", threadId: "thr-1" } } };
          },
        },
      },
    }),
    auth: { OAuth2: class {} },
  },
}));

vi.mock("@/lib/oauth-helpers", () => ({
  getOAuth2Client: () => ({ setCredentials: () => {} }),
  refreshTokenIfNeeded: async () => {},
}));

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: () => {
      const conn = {
        gmail_address: "me@gmail.com",
        access_token: "at",
        refresh_token: "rt",
        token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
        last_gmail_sync_at: null,
        id: 1,
        created_at: null,
      };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) chain[m] = () => chain;
      chain.single = async () => ({ data: conn, error: null });
      chain.maybeSingle = async () => ({ data: conn, error: null });
      return chain;
    },
  }),
}));

import { buildMimeMessage, createDraft } from "@/lib/gmail";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8");

beforeEach(() => {
  draftCreateCalls.length = 0;
});

describe("buildMimeMessage", () => {
  it("composes the expected headers and HTML body", () => {
    const raw = buildMimeMessage("me@gmail.com", {
      to: "jane@corp.com",
      subject: "Hello there",
      bodyHtml: "<p>Hi</p>",
    });
    const mime = decode(raw);
    expect(mime).toContain("From: me@gmail.com");
    expect(mime).toContain("To: jane@corp.com");
    expect(mime).toContain("Subject: Hello there");
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(mime.endsWith("\r\n\r\n<p>Hi</p>")).toBe(true);
    expect(mime).not.toContain("Cc:");
    expect(mime).not.toContain("In-Reply-To:");
  });

  it("includes optional cc/bcc and reply threading headers when provided", () => {
    const raw = buildMimeMessage("me@gmail.com", {
      to: "jane@corp.com",
      cc: "cc@corp.com",
      bcc: "bcc@corp.com",
      subject: "Re: Hello",
      bodyHtml: "<p>Hi</p>",
      inReplyTo: "<orig@mail.gmail.com>",
      references: "<orig@mail.gmail.com>",
    });
    const mime = decode(raw);
    expect(mime).toContain("Cc: cc@corp.com");
    expect(mime).toContain("Bcc: bcc@corp.com");
    expect(mime).toContain("In-Reply-To: <orig@mail.gmail.com>");
    expect(mime).toContain("References: <orig@mail.gmail.com>");
  });
});

describe("createDraft", () => {
  it("creates a Gmail draft with the composed MIME and returns ids", async () => {
    const result = await createDraft("user-1", {
      to: "jane@corp.com",
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
    });

    expect(result).toMatchObject({ draftId: "draft-1", messageId: "msg-1", threadId: "thr-1" });
    expect(result.webUrl).toContain("mail.google.com");

    expect(draftCreateCalls).toHaveLength(1);
    const body = draftCreateCalls[0].requestBody as { message: { raw: string; threadId?: string } };
    expect(decode(body.message.raw)).toContain("To: jane@corp.com");
    expect(body.message.threadId).toBeUndefined();
  });

  it("threads the draft as a reply when threadId is given", async () => {
    await createDraft("user-1", {
      to: "jane@corp.com",
      subject: "Re: Hello",
      bodyHtml: "<p>Hi</p>",
      threadId: "thr-9",
    });
    const body = draftCreateCalls[0].requestBody as { message: { raw: string; threadId?: string } };
    expect(body.message.threadId).toBe("thr-9");
  });
});
