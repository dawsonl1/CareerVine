/**
 * RFC threading headers for follow-up sends (CAR-214).
 *
 * Gmail groups a sent message into the right conversation server-side purely
 * from `threadId`, so the SENDER's mailbox threads correctly no matter what
 * headers we write. The RECIPIENT's client has no such affordance: it threads
 * on In-Reply-To / References, matching them against the RFC 822 `Message-ID`
 * of a message it has already seen.
 *
 * Both follow-up senders used to pass `email_follow_ups.original_gmail_message_id`
 * into those headers. That column holds the **Gmail API id** (`res.data.id`
 * from messages.send — e.g. `19f6701a3d3b3935`), not the RFC Message-ID
 * (`<CA+...@mail.gmail.com>`). The result was a header naming a msg-id that
 * exists nowhere, so every auto-sent follow-up arrived as a standalone message
 * in the contact's inbox instead of a reply on the original thread. It looked
 * correct from our side, which is why it survived so long.
 *
 * The two ids are documented as distinct in lib/types.ts (`messageId` is
 * "carried for threading headers (In-Reply-To / References) only"), and the
 * MCP compose path already resolved them correctly in `resolveReplyHeaders`.
 * This module is that same resolution, shared by the two follow-up senders.
 *
 * Nothing caches the RFC Message-ID — `email_messages` has no column for it —
 * so it is read from Gmail. The cron already fetches the thread for reply
 * detection and passes it in, making the correct path free there.
 */

import type { gmail_v1 } from "@googleapis/gmail";
import { getGmailClient } from "@/lib/gmail-send-core";
import { getHeader, type ParsedHeader } from "@/lib/gmail-helpers";

/** Metadata headers a thread fetch must request for this module to work. */
export const THREADING_METADATA_HEADERS = ["Message-ID"] as const;

export interface ThreadHeaders {
  inReplyTo?: string;
  references?: string;
}

/**
 * A Message-ID is `<addr-spec>` (RFC 5322 §3.6.4). Gmail emits the angle
 * brackets; some senders omit them. Anything without an `@` is not a msg-id —
 * most importantly a bare Gmail API id, the exact value this module exists to
 * stop shipping — and is dropped rather than wrapped, because inventing
 * brackets around a non-address would just produce a different bogus header.
 */
function normalizeMessageId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  if (!bare.includes("@")) return null;
  // CR/LF would break out of the header; sanitizeHeaderValue strips it at the
  // MIME boundary too, but a value that needs stripping is not a real msg-id.
  if (/[\r\n]/.test(bare)) return null;
  return `<${bare}>`;
}

/** Pull every usable Message-ID from a fetched thread, in thread order. */
function collectMessageIds(thread: gmail_v1.Schema$Thread): string[] {
  const ids: string[] = [];
  for (const message of thread.messages ?? []) {
    const headers = (message.payload?.headers ?? []) as ParsedHeader[];
    const id = normalizeMessageId(
      getHeader(headers, "Message-ID") || getHeader(headers, "Message-Id"),
    );
    // De-dupe: References must not repeat an id, and a thread can surface the
    // same message twice across label views.
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Build In-Reply-To / References for a follow-up about to be sent into
 * `threadId`.
 *
 * `inReplyTo` names the newest message in the thread rather than the original:
 * a follow-up is a reply to the conversation as it now stands, and clients
 * indent most sensibly under the latest turn. `references` carries the whole
 * chain, oldest first, which is what lets a client that never saw an
 * intermediate message still attach this one to the root.
 *
 * Returns `{}` when the ids cannot be resolved — a thread that 404s (the
 * parent scheduled email has not sent yet), a revoked token, a thread whose
 * messages carry no Message-ID. **Omitting the headers is deliberate and is
 * the whole point of the change**: Gmail still threads it for the sender via
 * threadId, whereas a malformed In-Reply-To threads for nobody and gives spam
 * filters a genuine signal to act on. Never fall back to the Gmail id.
 */
export async function resolveFollowUpThreadHeaders(
  userId: string,
  threadId: string | null | undefined,
  opts: { thread?: gmail_v1.Schema$Thread } = {},
): Promise<ThreadHeaders> {
  if (!threadId) return {};

  let thread = opts.thread;
  if (!thread) {
    try {
      const gmail = await getGmailClient(userId);
      const res = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: [...THREADING_METADATA_HEADERS],
      });
      thread = res.data;
    } catch {
      // Best-effort by design (see the doc comment): a failed lookup must not
      // block the send, and must not resurrect the bogus-header fallback.
      return {};
    }
  }

  const ids = collectMessageIds(thread);
  if (ids.length === 0) return {};

  return {
    inReplyTo: ids[ids.length - 1],
    references: ids.join(" "),
  };
}
