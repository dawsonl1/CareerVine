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
 */
function makeDb(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? [];
    let updatePayload: Record<string, unknown> | null = null;
    const filters: Array<(r: Row) => boolean> = [];
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
      then: (resolve: (v: unknown) => unknown) => {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
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

const okSend = () => Promise.resolve({ messageId: "m1", threadId: "t1" });

describe("processScheduledEmails claim step (CAR-134)", () => {
  it("two concurrent drivers send a due email exactly once", async () => {
    const rows = [scheduledRow()];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: [] });
    const send = vi.fn(async () => {
      // Hold the race window open across event-loop ticks, like a real
      // Gmail round trip.
      await new Promise((r) => setTimeout(r, 5));
      return { messageId: "m1", threadId: "t1" };
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
    const followUps: Row[] = [{ id: 9, status: "active", scheduled_email_id: 1 }];
    const db = makeDb({ scheduled_emails: rows, email_follow_ups: followUps });

    const result = await processScheduledEmails("u1", { service: db, send: okSend });

    expect(result).toEqual({ sent: 1, errors: 0 });
    expect(rows[0].status).toBe("sent");
    expect(rows[0].sent_thread_id).toBe("t1");
    expect(followUps[0].original_gmail_message_id).toBe("m1");
    expect(followUps[0].thread_id).toBe("t1");
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
