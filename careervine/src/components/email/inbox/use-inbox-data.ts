import { useCallback, useEffect, useState } from "react";
import type { EmailMessage, EmailFollowUp, ScheduledEmail, EmailDraft } from "@/lib/types";
import { runFullGmailSync } from "@/lib/gmail-sync-client";
import { UI_EVENTS, onUiEvent } from "@/lib/ui-events";
import type { GmailLabel, LinkedCalendarEvent } from "./inbox-types";

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
      const res = await fetch("/api/gmail/inbox");
      const data = await res.json();
      if (data.success) {
        setEmails(data.emails || []);
        setTrashedEmails(data.trashedEmails || []);
        setHiddenEmails(data.hiddenEmails || []);
        setScheduledEmails(data.scheduledEmails || []);
        setFollowUps(data.followUps || []);
        setContactMap(data.contactMap || {});
        setCalendarByThread(data.calendarByThread || {});
        setGmailAddress(data.gmailAddress || "");
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
      const res = await fetch("/api/gmail/drafts");
      const data = await res.json();
      setDrafts(data.drafts || []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (user && gmailConnected) {
      loadInbox();
      loadDrafts();
      fetch("/api/gmail/labels")
        .then((r) => r.json())
        .then((d) => setGmailLabels(d.labels || []))
        .catch(() => {});
    } else {
      setLoading(false);
    }
  }, [user, gmailConnected, loadInbox, loadDrafts]);

  useEffect(() => {
    return onUiEvent(UI_EVENTS.emailSent, () => {
      setTimeout(() => loadInbox(), 500);
      loadDrafts();
    });
  }, [loadInbox, loadDrafts]);

  // Refresh drafts when compose saves/deletes a draft.
  useEffect(() => {
    return onUiEvent(UI_EVENTS.draftsChanged, () => loadDrafts());
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
