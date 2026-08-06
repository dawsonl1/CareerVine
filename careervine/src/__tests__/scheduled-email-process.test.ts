import { describe, it, expect, vi } from "vitest";
import { processScheduledEmails } from "@/lib/gmail";
import { SendPolicyError } from "@/lib/email-send";

/**
 * CAR-134: processScheduledEmails must claim each row atomically before the
 * Gmail round trip. The 15-minute cron is the sole send driver (CAR-139
 * removed the page-load process triggers), but overlapping cron ticks can
 * still run it concurrently for the same user, so without the claim a due
 * email can be sent twice.
 */

type Row = Record<string, unknown> & { id: number; status: string };

function scheduledRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    user_id: "u1",
    recipient_email: "jane@corp.com",
    cc: null,
    bcc: null,
    subject: "Hello",
    body_html: "<p>Hi</p>",
    thread_id: null,
    in_reply_to: null,
    references_header: null,
    scheduled_send_at: "2020-01-01T00:00:00.000Z",
    status: "pending",
    claimed_at: null,
    ...overrides,
  };
}

/**
 * In-memory row store with real filter/update semantics. The `then` body runs
 * synchronously (filter + assign in one JS tick), which mirrors the row-level
 * atomicity Postgres gives a single conditional UPDATE — so a lost CAS shows
 * up as count 0 exactly like production.
 *
 * `failUpdate` simulates a transport-level failure (fetch rejection, not a
 * PostgREST error-as-value): a matching update rejects without touching rows.
 */
function makeDb(
  tables: Record<string, Row[]>,
  failUpdate?: (table: string, payload: Record<string, unknown>) => boolean,
) {
  function from(table: string) {
    const rows = tables[table] ?? [];
    let updatePayload: Record<string, unknown> | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    // Real slicing, not a no-op: paginateAll walks .range() windows, so a fake
    // that ignored them would pass a paginated read that pages wrongly (CAR-223).
    let window: [number, number] | null = null;
    const builder: Record<string, unknown> = {
      select: () => builder,
      update: (p: Record<string, unknown>) => {
        updatePayload = p;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      lte: (col: string, val: string) => {
        filters.push((r) => String(r[col]) <= val);
        return builder;
      },
      lt: (col: string, val: string) => {
        filters.push((r) => r[col] != null && String(r[col]) < val);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      range: (from: number, to: number) => {
        window = [from, to];
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (updatePayload && failUpdate?.(table, updatePayload)) {
          return Promise.reject(new Error(`network failure updating ${table}`)).then(resolve, reject);
        }
        const all = rows.filter((r) => filters.every((f) => f(r)));
        const matched = window ? all.slice(window[0], window[1] + 1) : all;
        if (updatePayload) {
          for (const r of matched) Object.assign(r, updatePayload);
          return Promise.resolve({ count: matched.length, data: null, error: null }).then(resolve);
        }
        return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(resolve);
      },
    };
    return builder;
  }
  return { from } as unknown as NonNullable<
    Parameters<typeof processScheduledEmails>[1]
  >["service"];
}

// Full TrackedSendResult so the mock is assignable to `typeof sendTrackedEmail`;
// processScheduledEmails only reads messageId/threadId, the rest are inert.
const okSend = () =>
  Promise.resolve({ messageId: "m1", threadId: "t1", matchedContactId: null, capRemaining: 1, warnings: [] });

describe("processScheduledEmails claim step (CAR-134)", () => {
  it("two concurrent drivers send a due email exactly once", async () => {
    const rows = [scheduledRow()];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: [] });
    const send = vi.fn(async () => {
      // Hold the race window open across event-loop ticks, like a real
      // Gmail round trip.
      await new Promise((r) => setTimeout(r, 5));
      return { messageId: "m1", threadId: "t1", matchedContactId: null, capRemaining: 1, warnings: [] };
    });

    const [a, b] = await Promise.all([
      processScheduledEmails("u1", { service: db, send }),
      processScheduledEmails("u1", { service: db, send }),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(a.sent + b.sent).toBe(1);
    expect(a.errors + b.errors).toBe(0);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].gmail_message_id).toBe("m1");
  });

  it("skips cleanly when the row is already claimed (no send, no error)", async () => {
    const rows = [scheduledRow({ status: "sending", claimed_at: "2020-01-01T00:00:00.000Z" })];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: [] });
    const send = vi.fn(okSend);

    const result = await processScheduledEmails("u1", { service: db, send });

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 0, errors: 0 });
    // Crash-after-send simulation: the row stays 'sending' for the cron
    // sweeper to flag — it is never re-sent by a process pass.
    expect(rows[0].status).toBe("sending");
  });

  it("marks the row sent and propagates ids to linked follow-ups", async () => {
    const rows = [scheduledRow()];
    const followUps: Row[] = [{ id: 9, user_id: "u1", status: "active", scheduled_email_id: 1 }];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: followUps });

    const result = await processScheduledEmails("u1", { service: db, send: okSend });

    expect(result).toEqual({ sent: 1, errors: 0 });
    expect(rows[0].status).toBe("sent");
    expect(rows[0].sent_thread_id).toBe("t1");
    // The back-fill is what RELEASES the sequence: it was dormant on a null
    // thread until this write gave it a real one.
    expect(followUps[0].original_gmail_message_id).toBe("m1");
    expect(followUps[0].thread_id).toBe("t1");
  });

  it("back-fills only the sending user's sequences, and only the live ones", async () => {
    const rows = [scheduledRow()];
    const followUps: Row[] = [
      { id: 9, user_id: "u1", status: "active", scheduled_email_id: 1, thread_id: null },
      // Retired BEFORE its opening email sent — reachable in production because
      // detectBounces cancels by recipient address, which matches a pre-send
      // sequence. Stamping it would rewrite the record of a sequence that never
      // ran (and never will: status is terminal).
      { id: 10, user_id: "u1", status: "cancelled_bounce", scheduled_email_id: 1, thread_id: null },
      { id: 11, user_id: "u1", status: "cancelled_user", scheduled_email_id: 1, thread_id: null },
      // Another tenant's row on the same link. The service client carries no
      // tenant scope of its own, so the filter is the only thing standing here.
      { id: 12, user_id: "u2", status: "active", scheduled_email_id: 1, thread_id: null },
    ];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: followUps });

    await processScheduledEmails("u1", { service: db, send: okSend });

    const byId = Object.fromEntries(followUps.map((f) => [f.id, f]));
    expect(byId[9].thread_id).toBe("t1");
    expect(byId[10].thread_id).toBeNull();
    expect(byId[11].thread_id).toBeNull();
    expect(byId[12].thread_id).toBeNull();
    // Status is never touched by the stamp, in either direction.
    expect(followUps.map((f) => f.status)).toEqual([
      "active",
      "cancelled_bounce",
      "cancelled_user",
      "active",
    ]);
  });

  it("releases the claim and stops the batch when the daily cap is hit (429)", async () => {
    const rows = [scheduledRow({ id: 1 }), scheduledRow({ id: 2 })];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: [] });
    const send = vi.fn(() => Promise.reject(new SendPolicyError("cap", 429)));

    const result = await processScheduledEmails("u1", { service: db, send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 0, errors: 0 });
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(rows[0].claimed_at).toBeNull();
  });

  it("releases the claim and continues past a bounced recipient (422)", async () => {
    const rows = [scheduledRow({ id: 1 }), scheduledRow({ id: 2 })];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: [] });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SendPolicyError("bounced", 422))
      .mockImplementation(okSend);

    const result = await processScheduledEmails("u1", { service: db, send });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ sent: 1, errors: 0 });
    expect(rows[0].status).toBe("pending");
    expect(rows[0].claimed_at).toBeNull();
    expect(rows[1].status).toBe("sent");
  });

  it("releases the claim on an unexpected send failure so the next tick retries", async () => {
    const rows = [scheduledRow()];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: [] });
    const send = vi.fn(() => Promise.reject(new Error("gmail 500")));

    const result = await processScheduledEmails("u1", { service: db, send });

    expect(result).toEqual({ sent: 0, errors: 1 });
    expect(rows[0].status).toBe("pending");
    expect(rows[0].claimed_at).toBeNull();
  });
});

/**
 * CAR-179: a failure AFTER the Gmail send (the mark-sent or follow-up-linking
 * write rejecting at the transport layer) must never release the claim — the
 * email is already delivered, and a released claim re-enters the pending pool
 * where the next tick would send a duplicate. The row stays 'sending' for the
 * stale-claim sweeper to flag 'failed', the same terminal path as a process
 * killed mid-send.
 */
describe("processScheduledEmails post-send failures (CAR-179)", () => {
  it("keeps the claim when the mark-sent write fails after delivery — no re-send on the next tick", async () => {
    const rows = [scheduledRow()];
    const db = makeDb(
      { scheduled_emails: rows, email_follow_ups: [] },
      (table, payload) => table === "scheduled_emails" && payload.status === "sent",
    );
    const send = vi.fn(okSend);

    const result = await processScheduledEmails("u1", { service: db, send });

    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 0, errors: 1 });
    // Delivered but unrecorded: the row must NOT return to pending.
    expect(rows[0].status).toBe("sending");

    // Next cron tick: the row is invisible to the pending query and the
    // claim CAS — nothing is sent a second time.
    const second = await processScheduledEmails("u1", { service: db, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ sent: 0, errors: 0 });
    expect(rows[0].status).toBe("sending");
  });

  it("keeps the row terminal when the follow-up-linking write fails after delivery", async () => {
    const rows = [scheduledRow()];
    const followUps: Row[] = [{ id: 9, status: "active", scheduled_email_id: 1 }];
    const db = makeDb(
      { scheduled_emails: rows, email_follow_ups: followUps },
      (table) => table === "email_follow_ups",
    );
    const send = vi.fn(okSend);

    const result = await processScheduledEmails("u1", { service: db, send });

    expect(result).toEqual({ sent: 0, errors: 1 });
    // Mark-sent landed before the follow-up write failed: 'sent' is terminal
    // and equally safe. The invariant is: never back to 'pending'.
    expect(rows[0].status).toBe("sent");

    const second = await processScheduledEmails("u1", { service: db, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ sent: 0, errors: 0 });
  });
});
