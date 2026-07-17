/**
 * Pure helper functions for Gmail email processing.
 * Extracted for testability.
 */

import type { EmailMessage } from "@/lib/types";

export type ParsedHeader = { name: string; value: string };

export type EmailThread = {
  threadId: string;
  subject: string;
  messages: EmailMessage[];
  latestDate: string;
  latestDirection: string | null;
  contactId: number | null;
};

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
    });
  }
  result.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
  return result;
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
