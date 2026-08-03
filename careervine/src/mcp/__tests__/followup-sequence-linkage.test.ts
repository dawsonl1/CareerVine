import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockServiceClientModule } from "../../__tests__/helpers/mock-supabase";
import { mockAnalyticsServerModule } from "../../__tests__/helpers/mock-analytics";
import { createRecordingClient, type RecordedQuery, type RouteCtx } from "./helpers/recording-client";

/**
 * CAR-214: what the MCP layer actually writes when a follow-up sequence is
 * queued behind an email that has not sent yet.
 *
 * Three linkage facts carry the whole feature, and each fails silently rather
 * than loudly if it regresses:
 *   - scheduled_email_id, or the scheduled-send cron never back-fills the
 *     thread and the sequence never fires at all;
 *   - NULL thread_id, or the follow-up cron's `thread_id is not null` filter
 *     stops holding the sequence dormant and steps race the opening email;
 *   - contact_id, or the sequence is invisible on the contact page, whose
 *     follow-up list filters on exactly that column.
 */

const state = vi.hoisted(() => ({
  recorded: [] as unknown[],
  route: (() => undefined) as (q: unknown) => unknown,
  nextId: 500,
}));

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => createRecordingClient(state as Parameters<typeof createRecordingClient>[0])),
);
vi.mock("@/lib/analytics/server", () =>
  mockAnalyticsServerModule({ trackServer: async () => {}, checkContactMilestone: async () => {} }),
);

const db = await import("../lib/db");

const USER = "11111111-1111-1111-1111-111111111111";
const SEND_AT = "2026-08-04T14:58:00.000Z";

const messageRows = [
  {
    follow_up_id: 0,
    sequence_number: 1,
    send_after_days: 6,
    subject: "Nudge",
    body_html: "<p>hi</p>",
    status: "pending" as const,
    scheduled_send_at: "2026-08-10T14:58:00.000Z",
  },
];

function recorded(): RecordedQuery[] {
  return state.recorded as RecordedQuery[];
}

/** The insert into the follow-up parent table, with its payload. */
function parentInsert() {
  return recorded().find((q) => q.table === "email_follow_ups" && q.op === "insert");
}

beforeEach(() => {
  state.recorded = [];
  state.route = () => undefined;
  state.nextId = 500;
  db.initDb(USER);
});

describe("insertFollowUpSequence linkage (pre-send anchor)", () => {
  it("links the sequence to the scheduled email and leaves both ids null", async () => {
    await db.insertFollowUpSequence({
      originalGmailMessageId: null,
      threadId: null,
      recipientEmail: "nathan@example.com",
      contactName: "Nathan",
      originalSubject: "Hi",
      originalSentAt: SEND_AT,
      contactId: 796,
      scheduledEmailId: 12,
      messageRows,
    });

    const payload = parentInsert()?.payload as Record<string, unknown>;
    expect(payload.scheduled_email_id).toBe(12);
    // Dormancy interlock: a placeholder string here would put the sequence in
    // the cron's due query before the opening email has a thread to reply to.
    expect(payload.thread_id).toBeNull();
    expect(payload.original_gmail_message_id).toBeNull();
    expect(payload.contact_id).toBe(796);
    expect(payload.user_id).toBe(USER);
    expect(payload.status).toBe("active");
  });

  it("carries contact_id on the already-sent anchor too", async () => {
    await db.insertFollowUpSequence({
      originalGmailMessageId: "19f6701a3d3b3935",
      threadId: "19f6701a3d3b3935",
      recipientEmail: "nathan@example.com",
      contactName: "Nathan",
      originalSubject: "Hi",
      originalSentAt: SEND_AT,
      contactId: 796,
      messageRows,
    });

    const payload = parentInsert()?.payload as Record<string, unknown>;
    expect(payload.contact_id).toBe(796);
    expect(payload.scheduled_email_id).toBeNull();
  });
});

describe("getPendingScheduledEmail", () => {
  const row = (status: string) => ({
    id: 12,
    recipient_email: "nathan@example.com",
    subject: "Hi",
    scheduled_send_at: SEND_AT,
    status,
    contact_name: "Nathan",
    matched_contact_id: 796,
  });

  it("returns a pending scheduled email scoped to the user", async () => {
    state.route = (q) => ((q as RouteCtx).table === "scheduled_emails" ? row("pending") : undefined);
    const out = await db.getPendingScheduledEmail(12);
    expect(out.recipient_email).toBe("nathan@example.com");

    const read = recorded().find((q) => q.table === "scheduled_emails");
    expect(read?.filters).toContainEqual(["eq", "user_id", USER]);
  });

  it("refuses an email that already sent", async () => {
    // Its thread exists, so the thread anchor is the correct tool; attaching
    // here would write a sequence the back-fill will never touch.
    state.route = (q) => ((q as RouteCtx).table === "scheduled_emails" ? row("sent") : undefined);
    await expect(db.getPendingScheduledEmail(12)).rejects.toThrow(/not pending/);
  });

  it("refuses a cancelled email, which will never produce a thread", async () => {
    state.route = (q) => ((q as RouteCtx).table === "scheduled_emails" ? row("cancelled") : undefined);
    await expect(db.getPendingScheduledEmail(12)).rejects.toThrow(/not pending/);
  });

  it("refuses an id that is not this user's", async () => {
    state.route = () => null;
    await expect(db.getPendingScheduledEmail(12)).rejects.toThrow(/No scheduled email with id 12/);
  });
});

describe("assertNoActiveSequenceForScheduledEmail", () => {
  it("passes when the scheduled email has no sequence yet", async () => {
    state.route = () => [];
    await expect(db.assertNoActiveSequenceForScheduledEmail(12)).resolves.toBeUndefined();
  });

  it("refuses a second sequence on the same scheduled email", async () => {
    // Otherwise a retried call stacks sequences that all fire once the opening
    // email sends, and the contact gets every nudge twice.
    state.route = (q) => ((q as RouteCtx).table === "email_follow_ups" ? [{ id: 9 }] : undefined);
    await expect(db.assertNoActiveSequenceForScheduledEmail(12)).rejects.toThrow(
      /already has an active follow-up sequence \(id 9\)/,
    );
  });

  it("scopes the duplicate check to the user and to active sequences", async () => {
    state.route = () => [];
    await db.assertNoActiveSequenceForScheduledEmail(12);
    const read = recorded().find((q) => q.table === "email_follow_ups");
    expect(read?.filters).toContainEqual(["eq", "user_id", USER]);
    expect(read?.filters).toContainEqual(["eq", "scheduled_email_id", 12]);
    expect(read?.filters).toContainEqual(["eq", "status", "active"]);
  });
});
