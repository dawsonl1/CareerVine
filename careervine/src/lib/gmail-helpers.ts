/**
 * Pure helper functions for Gmail email processing.
 * Extracted for testability.
 */

import type { EmailMessage, EmailThread } from "@/lib/types";

/**
 * Re-exported so the many `import { buildThreads, type EmailThread }` call
 * sites keep working. The definition itself moved to `types.ts` (CAR-260)
 * because the timeline's row union now references it, and having `types.ts`
 * import it back from here would be a cycle.
 */
export type { EmailThread };

export type ParsedHeader = { name: string; value: string };

/** All contacts a message is attributed to: the junction set if present, else the primary. */
function messageContactIds(m: EmailMessage): number[] {
  if (m.contact_ids && m.contact_ids.length > 0) return m.contact_ids;
  return m.matched_contact_id != null ? [m.matched_contact_id] : [];
}

/** Group flat email list into threads, sorted by latest date desc. */
export function buildThreads(msgs: EmailMessage[]): EmailThread[] {
  const map = new Map<string, EmailMessage[]>();
  for (const email of msgs) {
    const tid = email.thread_id || email.gmail_message_id;
    if (!map.has(tid)) map.set(tid, []);
    map.get(tid)!.push(email);
  }
  const result: EmailThread[] = [];
  for (const [threadId, threadMsgs] of map) {
    threadMsgs.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());
    const latest = threadMsgs[threadMsgs.length - 1];
    result.push({
      threadId,
      subject: threadMsgs[0].subject || "(no subject)",
      messages: threadMsgs,
      latestDate: latest.date || "",
      latestDirection: latest.direction,
      contactId: threadMsgs[0].matched_contact_id,
      contactIds: [...new Set(threadMsgs.flatMap(messageContactIds))],
    });
  }
  result.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
  return result;
}

// ── Mailbox membership (CAR-219) ──
//
// A mailbox view selects whole CONVERSATIONS by who has written on them, and
// every selected thread then renders in full — the way Gmail opens the same
// complete conversation whether you reached it from the Inbox or from Sent.
// Filtering the messages instead would show each side a half-conversation: our
// own outreach missing from a thread opened in the Inbox, the contact's reply
// missing from the copy reached via Sent. Threads both parties have written on
// belong to both views, exactly as in Gmail.
//
// Deliberately direction-based rather than INBOX/SENT-label-based: label_ids
// only stays current for messages a later sync re-fetches (the query is
// watermarked by date), and the app already owns an explicit archive in the
// Hidden tab, so honoring Gmail's archive here would strand threads in a view
// that has no home for them.

/** Somebody wrote TO the user on this thread, so the Inbox holds it. */
export function isReceivedThread(thread: EmailThread): boolean {
  return thread.messages.some((m) => m.direction === "inbound");
}

/** The user wrote on this thread, so Sent holds it. */
export function isSentThread(thread: EmailThread): boolean {
  return thread.messages.some((m) => m.direction === "outbound");
}

/** Find a header value by name (case-insensitive). */
export function getHeader(headers: ParsedHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

/** Extract a bare email address from a raw From/To header value. */
export function parseEmailAddress(raw: string): string {
  const match = raw.match(/<(.+?)>/);
  return (match ? match[1] : raw).toLowerCase().trim();
}

/**
 * The set of addresses that count as "the user themself": the primary Gmail
 * address plus any send-as aliases (CAR-153 / R2.5). Mail From any of these is
 * outbound; calendar attendees matching any of these are self, not contacts.
 * `aliases` is the raw jsonb value from gmail_connections.send_as_aliases —
 * typed unknown because a NULL/malformed value must degrade to primary-only,
 * never throw mid-sync.
 */
export function buildOwnAddressSet(
  primary: string | null | undefined,
  aliases?: unknown
): Set<string> {
  const set = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const clean = v.toLowerCase().trim();
    if (clean) set.add(clean);
  };
  add(primary);
  if (Array.isArray(aliases)) for (const a of aliases) add(a);
  return set;
}

/** Flatten a gmail_connections row into the own-address list for sync calls. */
export function ownAddressesFromConnection(conn: {
  gmail_address: string;
  send_as_aliases?: unknown;
}): string[] {
  return [...buildOwnAddressSet(conn.gmail_address, conn.send_as_aliases)];
}

/**
 * True when an address is a mail-system bounce sender (NDR), not a person.
 * Reply detection must skip these: an NDR inside a followed thread is a
 * delivery FAILURE, and treating it as "the contact wrote back" cancels the
 * sequence as replied and activates the very contact whose address bounced.
 * detectBounces owns NDRs and cancels via cancelled_bounce instead.
 */
export function isBounceSenderAddress(addr: string): boolean {
  return /^(mailer-daemon|postmaster)@/i.test(addr);
}

/**
 * True if `dateStr` is a valid timestamp within the last `days` days. Wraps the
 * `Date.now()` recency check so render code (e.g. the "Follow-up" affordance on
 * recent outbound mail) stays free of impure calls — the time read lives here.
 */
export function isWithinDays(dateStr: string | null | undefined, days: number): boolean {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t < days * 86400_000;
}
