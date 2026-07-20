import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the shared tracked-send path (plan 26).
 *
 * Policies pinned here:
 *   1. Daily cap refuses the send before Gmail is touched.
 *   2. Bounced recipient addresses are refused outright.
 *   3. Pattern-guessed addresses send but carry a warning.
 *   4. A matched contact gets an interaction logged; the sent message
 *      is cached as outbound.
 *   5. NO tier graduation on outbound send — the contacts table is
 *      never written (reply-based graduation policy).
 */

// ── Gmail send-core mock (CAR-147: primitives moved to gmail-send-core) ──

const sendEmailMock = vi.fn(async () => ({ messageId: "msg-1", threadId: "thr-1" }));

vi.mock("@/lib/gmail-send-core", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])),
  getConnection: async () => ({ gmail_address: "Me@Example.com" }),
}));

// ── Supabase service-client mock ───────────────────────────────────────

interface MockState {
  sentToday: number;
  emailRows: Array<{ contact_id: number; source: string; bounced_at: string | null }>;
  /** Injected PostgREST error for the daily-cap count read. */
  capError: { message: string } | null;
  /** Injected PostgREST error for the recipient-provenance read. */
  provenanceError: { message: string } | null;
}

const state: MockState = { sentToday: 0, emailRows: [], capError: null, provenanceError: null };
const tablesTouched: string[] = [];
const upserts: Array<{ table: string; row: Record<string, unknown> }> = [];
const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

function makeBuilder(table: string) {
  let op: "select" | "upsert" | "insert" = "select";

  const resolveResult = () => {
    if (op === "upsert" || op === "insert") return { error: null };
    if (table === "email_messages") return { count: state.sentToday, error: state.capError };
    if (table === "contact_emails") return { data: state.emailRows, error: state.provenanceError };
    return { data: [] };
  };

  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "in", "limit", "order"]) {
    chain[m] = () => chain;
  }
  chain.upsert = (row: Record<string, unknown>) => {
    op = "upsert";
    upserts.push({ table, row });
    return chain;
  };
  chain.insert = (row: Record<string, unknown>) => {
    op = "insert";
    inserts.push({ table, row });
    return chain;
  };
  // The sent-message cache upsert reads back its generated id (CAR-159).
  chain.single = async () =>
    op === "upsert" && table === "email_messages"
      ? { data: { id: 501 }, error: null }
      : { data: null, error: null };
  chain.then = (
    onFulfilled?: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(resolveResult()).then(onFulfilled, onRejected);
  return chain;
}

vi.mock("@/lib/supabase/service-client", () => ({
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      tablesTouched.push(table);
      return makeBuilder(table);
    },
  }),
}));

import { sendTrackedEmail, SendPolicyError, DAILY_SEND_CAP } from "@/lib/email-send";

const USER = "user-1";
const OPTS = { to: "Jane@Corp.com", subject: "Hello", bodyHtml: "<p>Hi Jane</p>" };

beforeEach(() => {
  state.sentToday = 0;
  state.emailRows = [];
  state.capError = null;
  state.provenanceError = null;
  tablesTouched.length = 0;
  upserts.length = 0;
  inserts.length = 0;
  sendEmailMock.mockClear();
});

describe("sendTrackedEmail", () => {
  it("refuses to send once the daily cap is hit, before touching Gmail", async () => {
    state.sentToday = DAILY_SEND_CAP;
    await expect(sendTrackedEmail(USER, OPTS)).rejects.toThrow(SendPolicyError);
    await expect(sendTrackedEmail(USER, OPTS)).rejects.toThrow(/Daily send limit/);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("refuses bounced recipient addresses", async () => {
    state.emailRows = [{ contact_id: 7, source: "verified", bounced_at: "2026-06-01T00:00:00Z" }];
    await expect(sendTrackedEmail(USER, OPTS)).rejects.toThrow(/bounced/);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends, caches the outbound message, and logs an interaction for a matched contact", async () => {
    state.sentToday = 5;
    state.emailRows = [{ contact_id: 7, source: "verified", bounced_at: null }];

    const result = await sendTrackedEmail(USER, OPTS);

    expect(result.messageId).toBe("msg-1");
    expect(result.matchedContactId).toBe(7);
    expect(result.capRemaining).toBe(DAILY_SEND_CAP - 6);
    expect(result.warnings).toEqual([]);

    const cached = upserts.find((u) => u.table === "email_messages");
    expect(cached?.row).toMatchObject({
      user_id: USER,
      gmail_message_id: "msg-1",
      direction: "outbound",
      matched_contact_id: 7,
      to_addresses: ["jane@corp.com"],
      // CAR-115: the full sent body is persisted so free-tier Outreach can re-read it.
      body_html: OPTS.bodyHtml,
    });

    const interaction = inserts.find((i) => i.table === "interactions");
    expect(interaction?.row).toEqual([
      expect.objectContaining({
        contact_id: 7,
        interaction_type: "email",
        summary: "Sent: Hello",
      }),
    ]);

    // CAR-159: the sent message is junction-linked to the matched contact.
    const links = upserts.find((u) => u.table === "email_message_contacts");
    expect(links?.row).toEqual([{ email_message_id: 501, contact_id: 7 }]);
  });

  it("links and logs every contact sharing the recipient address (CAR-159)", async () => {
    state.emailRows = [
      { contact_id: 7, source: "verified", bounced_at: null },
      { contact_id: 9, source: "verified", bounced_at: null },
    ];

    await sendTrackedEmail(USER, OPTS);

    const links = upserts.find((u) => u.table === "email_message_contacts");
    expect(links?.row).toEqual([
      { email_message_id: 501, contact_id: 7 },
      { email_message_id: 501, contact_id: 9 },
    ]);

    const interaction = inserts.find((i) => i.table === "interactions");
    const rows = interaction?.row as unknown as Array<{ contact_id: number }>;
    expect(rows.map((r) => r.contact_id)).toEqual([7, 9]);
  });

  it("never writes the contacts table — outbound sends do not graduate tiers", async () => {
    state.emailRows = [{ contact_id: 7, source: "verified", bounced_at: null }];
    await sendTrackedEmail(USER, OPTS);
    expect(tablesTouched).not.toContain("contacts");
  });

  it("warns (but still sends) on pattern-guessed addresses", async () => {
    state.emailRows = [{ contact_id: 7, source: "pattern_guessed", bounced_at: null }];
    const result = await sendTrackedEmail(USER, OPTS);
    expect(result.warnings.some((w) => w.includes("pattern-guessed"))).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledOnce();
  });

  it("skips interaction logging when the recipient matches no contact", async () => {
    const result = await sendTrackedEmail(USER, OPTS);
    expect(result.matchedContactId).toBeNull();
    expect(inserts.find((i) => i.table === "interactions")).toBeUndefined();
  });

  // ── Read failures must never read as "clear to send" (CAR-158) ──────────

  it("refuses the send when the daily-cap count read fails", async () => {
    // A failed count used to destructure as undefined, compare as 0 against the
    // cap, and wave every send through with the guardrail effectively off.
    state.capError = { message: "statement timeout" };
    await expect(sendTrackedEmail(USER, OPTS)).rejects.toMatchObject({ message: "statement timeout" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("refuses the send when the recipient-provenance read fails", async () => {
    // Empty-on-error here means "this address has never bounced", which would
    // send straight at a known-dead address and burn deliverability.
    state.provenanceError = { message: "connection reset" };
    await expect(sendTrackedEmail(USER, OPTS)).rejects.toMatchObject({ message: "connection reset" });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
