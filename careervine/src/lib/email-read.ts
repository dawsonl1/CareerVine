/**
 * The read state that follows from replying (CAR-276).
 *
 * ONE invariant, enforced from two directions:
 *
 *     An inbound message is read if you sent an outbound message on the same
 *     thread at a later time.
 *
 * Before this, `is_read` flipped true in exactly one place — markMessageAsRead,
 * reachable only by expanding a message body in the Inbox. So a thread you had
 * already answered kept counting toward the nav unread badge and kept rendering
 * bold until you went back and opened the message you had already dealt with.
 * sendTrackedEmail writes its OWN outbound row read and never touched the
 * inbound rows on the thread it was answering.
 *
 * MONOTONIC: false to true, never the reverse. That is what makes this
 * compatible with the deliberate "never overwrite is_read" guard in
 * syncEmailsForContact rather than a violation of it. That guard exists to stop
 * Gmail's label state from flipping a locally-read message BACK to unread; this
 * never moves in that direction, so the guard and its test stand unchanged.
 *
 * The cutoff is derived from the thread's own latest outbound row rather than
 * passed in as a timestamp. Both callers therefore share one rule, and neither
 * can hand it a clock that disagrees with the data:
 *
 *   - sendTrackedEmail, straight after it caches the message it just sent, with
 *     syncGmail so the user's actual Gmail inbox agrees with CareerVine.
 *   - the two sync ingest paths, keyed on threads where the pass ingested an
 *     OUTBOUND message. That is precisely the new information — you replied from
 *     Gmail or your phone, and Gmail cleared UNREAD on its side while our row
 *     kept the stale `false` it was first written with. DB-only there: Gmail
 *     already agrees, so the API call would be a round trip to set what is set.
 *
 * No tier gate, deliberately. Unread inbound rows only exist behind
 * `mailbox:read`, which free connections do not hold, so on the free tier the
 * first read comes back empty and the Gmail call is never reached. Data-gated,
 * not tier-gated — nothing to keep in sync with capabilities/map.ts.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { EmailDirection } from "@/lib/constants";
import { chunkList, chunkedPaginated } from "@/lib/data/postgrest";
import { getGmailClient } from "@/lib/gmail-send-core";

interface UnreadRow {
  id: number;
  gmail_message_id: string | null;
  thread_id: string | null;
  date: string | null;
  is_simulated: boolean | null;
}

interface OutboundRow {
  thread_id: string | null;
  date: string | null;
}

/** Epoch ms for a nullable timestamp column, or NaN when it can't be trusted. */
function timeOf(value: string | null): number {
  return value ? Date.parse(value) : NaN;
}

/**
 * Apply the reply-implies-read invariant to `threadIds`. Returns how many
 * messages actually flipped.
 *
 * Throws on a failed read or write: a caller that wants this to be non-fatal
 * says so at its own call site, because "who is allowed to fail the user's
 * send/sync" is the caller's decision, not this function's.
 */
export async function reconcileThreadReadState(
  service: SupabaseClient,
  userId: string,
  threadIds: Iterable<string | null | undefined>,
  opts: { syncGmail?: boolean } = {},
): Promise<number> {
  const ids = [...new Set([...threadIds].filter((t): t is string => Boolean(t)))];
  if (ids.length === 0) return 0;

  // chunkedPaginated, not a bare .in(): the thread list is caller-supplied (a
  // sync page carries every thread it touched) and email_messages FANS OUT per
  // thread, so both the URL-length bound and the silently-truncating 1000-row
  // response cap are live. Truncation here would read as "nothing unread".
  const unread = await chunkedPaginated<UnreadRow, string>(ids, async (chunk, from, to) => {
    const { data, error } = await service
      .from("email_messages")
      // exclusion-exempt: read-state bookkeeping. This selects rows to reconcile is_read ON. The values the user actually sees — the nav badge, the Inbox list — apply their own is_trashed/is_hidden filters downstream of the flag this sets.
      .select("id, gmail_message_id, thread_id, date, is_simulated")
      .eq("user_id", userId)
      .in("thread_id", chunk)
      .eq("direction", EmailDirection.Inbound)
      .eq("is_read", false)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    return data as UnreadRow[] | null;
  });
  if (unread.length === 0) return 0;

  // Narrowed to threads that actually have something unread: on the send path
  // the vast majority of threads are already fully read, and asking about them
  // is a round trip that can only ever return rows we would discard.
  const candidateThreads = [
    ...new Set(unread.map((r) => r.thread_id).filter((t): t is string => Boolean(t))),
  ];

  const outbound = await chunkedPaginated<OutboundRow, string>(
    candidateThreads,
    async (chunk, from, to) => {
      const { data, error } = await service
        .from("email_messages")
        // exclusion-exempt: asks whether WE wrote on this thread and when, which is what makes an inbound message answered at all. Striking our own sent message does not unsend it. Same stance the reply-attribution reads in gmail.ts take.
        .select("thread_id, date")
        .eq("user_id", userId)
        .in("thread_id", chunk)
        .eq("direction", EmailDirection.Outbound)
        .order("id", { ascending: true })
        .range(from, to);
      if (error) throw error;
      return data as OutboundRow[] | null;
    },
  );

  const repliedAtByThread = new Map<string, number>();
  for (const row of outbound) {
    if (!row.thread_id) continue;
    const sentAt = timeOf(row.date);
    if (Number.isNaN(sentAt)) continue;
    const known = repliedAtByThread.get(row.thread_id);
    if (known === undefined || sentAt > known) repliedAtByThread.set(row.thread_id, sentAt);
  }

  // A row whose Date header was missing or unparseable cannot be PROVEN to
  // predate the reply, so it stays unread. Failing toward "still unread" is the
  // safe direction here: the cost is a badge one too high, not a message the
  // user never learns about. Strict `<` for the same reason — a message that
  // landed at the same instant we sent is not one we answered.
  const answered = unread.filter((row) => {
    if (!row.thread_id) return false;
    const repliedAt = repliedAtByThread.get(row.thread_id);
    if (repliedAt === undefined) return false;
    const receivedAt = timeOf(row.date);
    return !Number.isNaN(receivedAt) && receivedAt < repliedAt;
  });
  if (answered.length === 0) return 0;

  for (const chunk of chunkList(answered, 200)) {
    const { error } = await service
      .from("email_messages")
      .update({ is_read: true })
      .eq("user_id", userId)
      .in(
        "id",
        chunk.map((r) => r.id),
      );
    if (error) throw error;
  }

  if (opts.syncGmail) {
    // is_simulated rows (the free tier's `manual-reply-<threadId>` placeholder)
    // carry an id Gmail has never heard of — sending it would 404 for nothing.
    await clearGmailUnread(
      userId,
      answered
        .filter((r) => !r.is_simulated)
        .map((r) => r.gmail_message_id)
        .filter((id): id is string => Boolean(id)),
    );
  }

  return answered.length;
}

/**
 * Remove Gmail's UNREAD label from messages we just marked read locally.
 *
 * DB first, Gmail best-effort — the same ordering and reasoning markMessageAsRead
 * documents: the local row is what the UI reads, so a token refresh failure or a
 * rate limit must not undo a state change the user has already earned.
 *
 * Per message rather than one threads.modify, even though the thread call would
 * be a single request: threads.modify clears UNREAD across the WHOLE thread,
 * including an inbound that arrived AFTER the reply, which the invariant above
 * deliberately leaves unread.
 */
async function clearGmailUnread(userId: string, gmailMessageIds: string[]): Promise<void> {
  if (gmailMessageIds.length === 0) return;

  let gmail: Awaited<ReturnType<typeof getGmailClient>>;
  try {
    gmail = await getGmailClient(userId);
  } catch (err) {
    console.error("Failed to open Gmail client to clear UNREAD:", err);
    return;
  }

  for (const id of gmailMessageIds) {
    try {
      await gmail.users.messages.modify({
        userId: "me",
        id,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    } catch (err) {
      console.error("Failed to remove UNREAD label in Gmail:", err);
    }
  }
}
