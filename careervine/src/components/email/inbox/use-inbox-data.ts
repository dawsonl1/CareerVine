import { useCallback, useEffect, useState } from "react";
import type { EmailMessage, EmailFollowUp, ScheduledEmail, EmailDraft } from "@/lib/types";
import { runFullGmailSync } from "@/lib/gmail-sync-client";
import { UI_EVENTS, onUiEvent } from "@/lib/ui-events";
import type { GmailLabel, LinkedCalendarEvent } from "./inbox-types";
import { apiFetch } from "@/lib/api-client";
import type { InferApiResponse } from "@/lib/api-handler";
import type { GET as InboxGET } from "@/app/api/gmail/inbox/route";
import type { GET as DraftsGET } from "@/app/api/gmail/drafts/route";
import type { GET as LabelsGET } from "@/app/api/gmail/labels/route";

/**
 * Typed off each route's own handler (CONVENTIONS.md §a), so producer and
 * consumer cannot drift: a route changing its success shape breaks this file at
 * compile time rather than at runtime.
 */
type InboxResponse = InferApiResponse<typeof InboxGET>;
type DraftsResponse = InferApiResponse<typeof DraftsGET>;
type LabelsResponse = InferApiResponse<typeof LabelsGET>;

interface UseInboxDataParams {
  user: { id: string } | null | undefined;
  gmailConnected: boolean;
}

/**
 * The inbox's data layer (CAR-150): owns every server-backed list, loads them on
 * connect, re-pulls on cross-view coherence events, and drives a full Gmail sync.
 * The shell coordinates optimistic writes against the exposed setters; this hook
 * only reads.
 */
export function useInboxData({ user, gmailConnected }: UseInboxDataParams) {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  // Distinguish a failed inbox fetch from a genuinely empty mailbox, so the
  // shell renders a retryable error instead of "No emails synced yet." (CAR-154).
  const [error, setError] = useState(false);
  // True once ANY inbox load has succeeded (even empty). Gates the shell's
  // full-screen error so a transient background-refresh failure over a
  // known-good empty mailbox can't replace the working page — mirrors the
  // dashboard's coreLoadedOnce (CAR-176).
  const [loadedOnce, setLoadedOnce] = useState(false);

  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [trashedEmails, setTrashedEmails] = useState<EmailMessage[]>([]);
  const [hiddenEmails, setHiddenEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [followUps, setFollowUps] = useState<EmailFollowUp[]>([]);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [contactMap, setContactMap] = useState<Record<number, string>>({});
  const [calendarByThread, setCalendarByThread] = useState<Record<string, LinkedCalendarEvent>>({});
  const [_gmailAddress, setGmailAddress] = useState("");
  const [gmailLabels, setGmailLabels] = useState<GmailLabel[]>([]);

  const loadInbox = useCallback(async () => {
    setError(false);
    try {
      // apiFetch throws on any non-2xx, so `data.success` is no longer the only
      // thing standing between a 500 and eight setState calls full of undefined.
      const data = await apiFetch<InboxResponse>("/api/gmail/inbox");
      if (data.success) {
        setEmails(data.emails || []);
        setTrashedEmails(data.trashedEmails || []);
        setHiddenEmails(data.hiddenEmails || []);
        setScheduledEmails(data.scheduledEmails || []);
        setFollowUps(data.followUps || []);
        setContactMap(data.contactMap || {});
        setCalendarByThread(data.calendarByThread || {});
        setGmailAddress(data.gmailAddress || "");
        setLoadedOnce(true);
      } else {
        setError(true);
      }
    } catch (err) {
      console.error("Failed to load inbox:", err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDrafts = useCallback(async () => {
    try {
      const data = await apiFetch<DraftsResponse>("/api/gmail/drafts");
      setDrafts(data.drafts || []);
    } catch {
      // error-tolerated: drafts are a secondary tab beside the inbox payload,
      // which owns this hook's `error` state. A failed drafts read leaves that
      // tab empty rather than taking the whole inbox down with it.
    }
  }, []);

  useEffect(() => {
    if (user && gmailConnected) {
      // Both loaders catch internally (loadInbox sets `error`, loadDrafts is
      // best-effort), so the effect fires them without awaiting.
      void loadInbox();
      void loadDrafts();
      apiFetch<LabelsResponse>("/api/gmail/labels")
        .then((d) => setGmailLabels(d.labels || []))
        // error-tolerated: labels populate the "Move to" menu only. The route is
        // capability-gated, so a free account 403s here by design and must not
        // see an error for a control it does not have.
        .catch(() => {});
    } else {
      setLoading(false);
    }
  }, [user, gmailConnected, loadInbox, loadDrafts]);

  useEffect(() => {
    return onUiEvent(UI_EVENTS.emailSent, () => {
      setTimeout(() => { void loadInbox(); }, 500);
      void loadDrafts();
    });
  }, [loadInbox, loadDrafts]);

  // Refresh drafts when compose saves/deletes a draft.
  useEffect(() => {
    return onUiEvent(UI_EVENTS.draftsChanged, () => { void loadDrafts(); });
  }, [loadDrafts]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      await runFullGmailSync();
    } catch (err) {
      console.error("Gmail sync failed:", err);
    } finally {
      // Show whatever did land, even after a partial or failed sync.
      await loadInbox().catch(() => {});
      setSyncing(false);
    }
  }, [loadInbox]);

  return {
    loading,
    // Exposed so the shell's error-state Retry can re-assert the spinner before
    // re-fetching; loadInbox itself must not set loading=true (the emailSent
    // refresh reuses it and would flash a full-screen spinner over a working
    // inbox). CAR-154 review.
    setLoading,
    syncing,
    error,
    loadedOnce,
    emails, setEmails,
    trashedEmails, setTrashedEmails,
    hiddenEmails, setHiddenEmails,
    scheduledEmails, setScheduledEmails,
    followUps, setFollowUps,
    drafts, setDrafts,
    contactMap,
    calendarByThread,
    gmailLabels,
    loadInbox,
    loadDrafts,
    handleSync,
  };
}
