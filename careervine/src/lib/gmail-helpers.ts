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
