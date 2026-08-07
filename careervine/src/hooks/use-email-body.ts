"use client";

import { useCallback, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { UI_EVENTS, emitUiEvent, unreadDeltaFor } from "@/lib/ui-events";
import { apiFetch, apiSend } from "@/lib/api-client";
import type { EmailMessage, EmailMessageFull } from "@/lib/types";

/**
 * Loads one message's full body, with the free-tier fallback (CAR-249).
 *
 * Extracted from contact-emails-tab.tsx, which owned the only copy until the
 * contact timeline's detail modal needed the same four behaviors. Two copies of
 * this would have been two places to get the capability gate wrong.
 *
 * The gate is the reason this is not a plain fetch. `canReadMailbox` is CAR-102's
 * premium live-mailbox scope; without it `/api/gmail/emails/{id}` 403s, so a free
 * user is served the snippet already cached on the row and the gated route is
 * never called. Marking read is likewise skipped: there is no live mailbox to
 * mirror the state back to.
 *
 * Ordering is guarded by useLatestRequest — bodies are keyed by message id and a
 * slower fetch for a message the user already navigated away from must not
 * overwrite the one they are reading (CAR-145 / F19).
 */
export function useEmailBody({
  canReadMailbox,
  markRead = false,
  onMarkedRead,
}: {
  canReadMailbox: boolean;
  /**
   * Mirror Gmail's read state when a body is opened. The contact Emails tab
   * passes true (opening a message there IS reading it); callers that render a
   * body they did not navigate to should not.
   */
  markRead?: boolean;
  /** Re-read the caller's message list so the cleared unread state shows. */
  onMarkedRead?: () => void;
} = { canReadMailbox: false }) {
  const req = useLatestRequest();
  const [content, setContent] = useState<EmailMessageFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * The re-entry guard, holding the id currently in flight rather than a bare
   * boolean. `load` carries a write — the mark-read POST — so a double click on
   * one row must not fire it twice; but a click on a DIFFERENT row must still
   * supersede, which a boolean would refuse. Synchronous, because no rendered
   * `disabled` exists in time for a double click's second event.
   */
  const inFlightRef = useRef<string | null>(null);

  const clear = useCallback(() => {
    setContent(null);
    setFailed(false);
    setLoading(false);
    // Bump the token so an in-flight body cannot land after the caller cleared,
    // and release the slot so re-opening the same message loads it again.
    req.begin();
    inFlightRef.current = null;
  }, [req]);

  /**
   * @param message - the cached row, which carries the free-tier fallback text
   * @returns whether this call was still the latest when it settled
   */
  const load = useCallback(
    async (message: EmailMessage): Promise<boolean> => {
      if (inFlightRef.current === message.gmail_message_id) return false;
      inFlightRef.current = message.gmail_message_id;
      const token = req.begin();
      setContent(null);
      setFailed(false);

      if (!canReadMailbox) {
        setContent({
          subject: message.subject || "",
          from: message.direction === "outbound" ? "You" : message.from_address || "Unknown",
          to: (message.to_addresses || []).join(", "),
          date: message.date || "",
          bodyHtml: null,
          bodyText: message.snippet || "No preview available for this message.",
          messageId: message.gmail_message_id,
          gmailMessageId: message.gmail_message_id,
          threadId: message.thread_id || "",
        });
        inFlightRef.current = null;
        return true;
      }

      setLoading(true);

      if (markRead && !message.is_read) {
        emitUiEvent(UI_EVENTS.unreadChanged, { delta: unreadDeltaFor(message) });
        // error-tolerated: marking read mirrors Gmail's own state rather than
        // anything the user asked for. The next sync re-derives it, and a toast
        // here would interrupt a read with news about bookkeeping.
        await apiSend(`/api/gmail/emails/${message.gmail_message_id}/read`, { method: "POST" }).catch(
          () => {},
        );
        emitUiEvent(UI_EVENTS.unreadChanged, { refetch: true });
        onMarkedRead?.();
      }

      try {
        const data = await apiFetch<{ success?: boolean; message?: EmailMessageFull }>(
          `/api/gmail/emails/${message.gmail_message_id}`,
        );
        if (!req.isLatest(token)) return false;
        if (data.success && data.message) {
          setContent(data.message);
        } else {
          setFailed(true);
        }
      } catch {
        if (!req.isLatest(token)) return false;
        setFailed(true);
      } finally {
        if (req.isLatest(token)) setLoading(false);
        // Cleared only by the call that still owns the slot, so a superseded
        // request settling late cannot unlock the one now in flight.
        if (inFlightRef.current === message.gmail_message_id) inFlightRef.current = null;
      }
      return req.isLatest(token);
    },
    [canReadMailbox, markRead, onMarkedRead, req],
  );

  return { content, loading, failed, load, clear };
}
