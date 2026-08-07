import { describe, it, expect } from "vitest";
import { getContactStages, setCompanyQueriesClient } from "@/lib/company-queries";

/**
 * Do we still owe this person a response? (CAR-253)
 *
 * Stage `replied` cannot answer that — it is sticky, so it stays true forever
 * once someone has written back once, and the companies card was using it to
 * issue a standing "write back" instruction on finished conversations.
 *
 * `replyThread` answers it instead, and every rule it follows is load-bearing:
 *
 *  - it is PER THREAD, so a later email on some unrelated thread cannot read as
 *    an answer to this one;
 *  - it anchors on their FIRST reply, so answering once retires the prompt for
 *    good — their replying again afterwards is a live exchange, not a task;
 *  - ANY unanswered thread is enough, because one conversation owed a response
 *    is a conversation owed a response;
 *  - a reply that predates our first outreach is not a reply to it, matching the
 *    gate the stage itself uses;
 *  - and with no message behind the stage at all it reports null rather than
 *    guessing, which is what a `stage_override` produces.
 *
 * Drives the real aggregation through the same tiny fake client as
 * contact-stages-inbound-attribution.test.ts.
 */

const USER = "user-1";
const THEM = 42;
const THEIR_ADDRESS = "sam@corp.com";

interface Msg {
  id: number;
  thread: string | null;
  dir: "inbound" | "outbound";
  date: string;
}

/** One junction row per message, shaped like the leg's actual select. */
function link(m: Msg) {
  return {
    contact_id: THEM,
    email_message_id: m.id,
    email_messages: {
      user_id: USER,
      direction: m.dir,
      date: m.date,
      from_address: m.dir === "inbound" ? THEIR_ADDRESS : "me@gmail.com",
      is_simulated: false,
      thread_id: m.thread,
    },
  };
}

function makeClient(messages: Msg[]) {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    email_message_contacts: messages.map(link),
    contact_emails: [{ contact_id: THEM, email: THEIR_ADDRESS }],
  };
  function from(table: string) {
    const notNullCols: string[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "gte", "lt", "neq"]) {
      builder[m] = () => builder;
    }
    // The bounces leg reuses contact_emails with .not(col, "is", null), so it
    // must only match rows that actually carry that column.
    builder.not = (col: string) => {
      notNullCols.push(col);
      return builder;
    };
    builder.range = () => builder;
    builder.then = (resolve: (v: unknown) => void) => {
      let data = rows[table] ?? [];
      for (const col of notNullCols) data = data.filter((r) => r[col] != null);
      resolve({ data, error: null });
    };
    return builder;
  }
  setCompanyQueriesClient({ from } as unknown as Parameters<typeof setCompanyQueriesClient>[0]);
}

async function replyThreadFor(messages: Msg[], stageOverride: string | null = null) {
  makeClient(messages);
  const stages = await getContactStages(USER, [{ id: THEM, stage_override: stageOverride }]);
  return stages.get(THEM);
}

describe("getContactStages — reply-thread state (CAR-253)", () => {
  it("reports a reply we have not answered, dated at their message", async () => {
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
    ]);
    expect(s?.stage).toBe("replied");
    expect(s?.replyThread).toEqual({
      awaitingOurReply: true,
      lastMessageAt: "2026-07-02T10:00:00Z",
      lastUnansweredReplyAt: "2026-07-02T10:00:00Z",
    });
  });

  it("clears once we have written back, and dates the thread at our message", async () => {
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t1", dir: "outbound", date: "2026-07-03T10:00:00Z" },
    ]);
    expect(s?.stage).toBe("replied");
    expect(s?.replyThread).toEqual({ awaitingOurReply: false, lastMessageAt: "2026-07-03T10:00:00Z", lastUnansweredReplyAt: null });
  });

  it("stays cleared when they reply AGAIN after our answer", async () => {
    // Dawson's case verbatim. Anchoring on their LATEST reply instead of their
    // first would flip this back to true and put the instruction back on a
    // conversation that is plainly already a conversation.
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t1", dir: "outbound", date: "2026-07-03T10:00:00Z" },
      { id: 4, thread: "t1", dir: "inbound", date: "2026-07-04T10:00:00Z" },
    ]);
    expect(s?.replyThread).toEqual({ awaitingOurReply: false, lastMessageAt: "2026-07-04T10:00:00Z", lastUnansweredReplyAt: null });
  });

  it("does not let a later email on a DIFFERENT thread answer this one", async () => {
    // The whole reason this is bucketed by thread. A contact-level "is our
    // latest outbound after their reply?" is true here and wrong: the reply on
    // t1 has never been answered.
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t2", dir: "outbound", date: "2026-07-05T10:00:00Z" },
    ]);
    expect(s?.replyThread?.awaitingOurReply).toBe(true);
  });

  it("one unanswered thread is enough, even beside an answered one", async () => {
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t1", dir: "outbound", date: "2026-07-03T10:00:00Z" },
      { id: 4, thread: "t2", dir: "outbound", date: "2026-07-04T10:00:00Z" },
      { id: 5, thread: "t2", dir: "inbound", date: "2026-07-06T10:00:00Z" },
    ]);
    expect(s?.replyThread).toEqual({
      awaitingOurReply: true,
      lastMessageAt: "2026-07-06T10:00:00Z",
      lastUnansweredReplyAt: "2026-07-06T10:00:00Z",
    });
  });

  it("ignores inbound mail that predates our first outreach", async () => {
    // Same gate the stage itself applies: old correspondence pulled in by the
    // history backfill is not a reply to an email we sent afterwards, so a
    // thread holding only that must not manufacture a response we owe.
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t1", dir: "outbound", date: "2026-07-03T10:00:00Z" },
      { id: 4, thread: "old", dir: "inbound", date: "2026-01-01T10:00:00Z" },
    ]);
    expect(s?.replyThread?.awaitingOurReply).toBe(false);
  });

  it("is null when nothing but an override says they replied", async () => {
    const s = await replyThreadFor([], "replied");
    expect(s?.stage).toBe("replied");
    expect(s?.replyThread).toBeNull();
  });

  it("is null for a contact who has simply not replied", async () => {
    const s = await replyThreadFor([{ id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" }]);
    expect(s?.stage).toBe("contacted");
    expect(s?.replyThread).toBeNull();
  });

  it("dates the awaited reply at their LATEST message on the unanswered thread", async () => {
    // Two unanswered replies on one thread. `awaitingOurReply` anchors on the
    // first; `lastUnansweredReplyAt` reports the latest, because the call_done
    // rung asks whether ANY unanswered reply postdates the conversation
    // (CAR-266) and the latest is the one that decides it.
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t1", dir: "inbound", date: "2026-07-06T10:00:00Z" },
    ]);
    expect(s?.replyThread).toEqual({
      awaitingOurReply: true,
      lastMessageAt: "2026-07-06T10:00:00Z",
      lastUnansweredReplyAt: "2026-07-06T10:00:00Z",
    });
  });

  it("never lets an ANSWERED thread's later reply feed lastUnansweredReplyAt", async () => {
    // t1 is answered (their second reply is a live exchange, CAR-253); t2 is
    // the unanswered one. The field must report t2's reply, not t1's newer
    // message — otherwise the finished conversation would keep promoting the
    // write-back line on the companies card.
    const s = await replyThreadFor([
      { id: 1, thread: "t1", dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: "t1", dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: "t1", dir: "outbound", date: "2026-07-03T10:00:00Z" },
      { id: 4, thread: "t1", dir: "inbound", date: "2026-07-09T10:00:00Z" },
      { id: 5, thread: "t2", dir: "outbound", date: "2026-07-04T10:00:00Z" },
      { id: 6, thread: "t2", dir: "inbound", date: "2026-07-05T10:00:00Z" },
    ]);
    expect(s?.replyThread).toEqual({
      awaitingOurReply: true,
      lastMessageAt: "2026-07-09T10:00:00Z",
      lastUnansweredReplyAt: "2026-07-05T10:00:00Z",
    });
  });

  it("keeps thread-less messages apart instead of merging them into one thread", async () => {
    // thread_id is nullable. Bucketing every such message together would let an
    // unrelated send answer a reply it has nothing to do with, so each falls
    // back to its own bucket and the reply stays outstanding.
    const s = await replyThreadFor([
      { id: 1, thread: null, dir: "outbound", date: "2026-07-01T10:00:00Z" },
      { id: 2, thread: null, dir: "inbound", date: "2026-07-02T10:00:00Z" },
      { id: 3, thread: null, dir: "outbound", date: "2026-07-05T10:00:00Z" },
    ]);
    expect(s?.replyThread?.awaitingOurReply).toBe(true);
  });
});
