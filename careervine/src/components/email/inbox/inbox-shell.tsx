"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import Navigation from "@/components/navigation";
import { FollowUpModal } from "@/components/follow-up-modal";
import type { EmailFollowUp, EmailDraft, EmailMessageFull } from "@/lib/types";
import { apiFetch, apiSend, jsonBody } from "@/lib/api-client";
import { withToastOnError } from "@/lib/with-toast-on-error";
import { Inbox, Clock, Send, Mail, Trash2, EyeOff, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { OAuthWarning } from "@/components/oauth-warning";
import { buildThreads, isReceivedThread, isSentThread, type EmailThread } from "@/lib/gmail-helpers";
import { isOpenFollowUpMessage } from "@/lib/constants";
import { trackBeforeNavigate } from "@/lib/analytics/client";
import { UI_EVENTS, emitUiEvent, unreadDeltaFor } from "@/lib/ui-events";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { useThreadExpansion } from "./use-thread-expansion";
import { ThreadListTab } from "./thread-list-tab";
import { DraftsTab } from "./drafts-tab";
import { ScheduledTab } from "./scheduled-tab";
import { FollowUpsTab } from "./followups-tab";
import { InboxTopBar } from "./inbox-top-bar";
import { InboxFilterBar } from "./inbox-filter-bar";
import { InboxSidebar, InboxMobileTabs } from "./inbox-nav";
import { useInboxFilters } from "./use-inbox-filters";
import { useInboxData } from "./use-inbox-data";
import { LoadErrorState, LoadErrorBanner } from "@/components/ui/load-error-state";
import { SectionBoundary } from "@/components/ui/section-boundary";
import type { FollowUpModalPayload, SidebarItem, SidebarTab } from "./inbox-types";

// ── Inbox shell (the premium paid experience; selected by EmailExperience, CAR-103) ──

export function InboxShell() {
  const { user } = useAuth();
  const router = useRouter();
  const { gmailConnected, gmailLoading, openCompose } = useCompose();
  const { error: toastError } = useToast();

  const [activeTab, setActiveTab] = useState<SidebarTab>("inbox");
  // Synchronous in-flight sets, per CONVENTIONS.md §f: a boolean state flag
  // updates asynchronously and would not block a fast second click.
  const cancellingRef = useRef<Set<number>>(new Set());
  const retryingRef = useRef<Set<number>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Server-backed data + loaders (CAR-150).
  const {
    loading,
    setLoading,
    syncing,
    error: loadError,
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
    handleSync,
  } = useInboxData({ user, gmailConnected });

  // Thread expansion — one reducer owns the 3-field invariant (CAR-150 / F22).
  const {
    expandedThreadId,
    expandedEmailId,
    expandedEmailContent,
    collapseAll,
    expandThread,
    expandEmail,
    collapseEmail,
    setContent: setExpandedContent,
  } = useThreadExpansion();
  const [loadingEmailContent, setLoadingEmailContent] = useState(false);
  // Drops a slower email-body fetch when the user expands another message,
  // collapses, or switches tabs before it resolves (CAR-145 / F19).
  const expandReq = useLatestRequest();

  // Follow-up modal
  const [followUpModal, setFollowUpModal] = useState<FollowUpModalPayload | null>(null);

  // Anything on screen the error UI could attach to or would wipe out.
  const anyInboxData =
    emails.length > 0 ||
    trashedEmails.length > 0 ||
    hiddenEmails.length > 0 ||
    scheduledEmails.length > 0 ||
    followUps.length > 0 ||
    drafts.length > 0;

  // A background refresh failing over a legitimately empty-but-loaded mailbox:
  // keep the working page (the full-screen error below is gated on
  // !loadedOnce) and surface the failure as a toast — there is no data-bearing
  // list for the partial-failure banner to sit above (CAR-176).
  useEffect(() => {
    if (loadError && !loading && loadedOnce && !anyInboxData) {
      toastError("Could not refresh your inbox. Please try again.");
    }
  }, [loadError, loading, loadedOnce, anyInboxData, toastError]);

  // ── Thread grouping ──

  // Gmail parity (CAR-219): group every message into conversations once, then
  // let each mailbox select whole threads by who has written on them. Both
  // views therefore show the complete conversation — a reply pulls our own
  // outreach into the Inbox with it, and Sent shows what came back rather than
  // just our side. Outreach nobody has answered belongs to Sent alone.
  const allThreads = useMemo(() => buildThreads(emails), [emails]);
  const inboxThreads = useMemo(() => allThreads.filter(isReceivedThread), [allThreads]);
  const sentThreads = useMemo(() => allThreads.filter(isSentThread), [allThreads]);
  const trashThreads = useMemo(() => buildThreads(trashedEmails), [trashedEmails]);
  const hiddenThreads = useMemo(() => buildThreads(hiddenEmails), [hiddenEmails]);

  // ── Follow-up lookup ──

  const followUpsByThread = useMemo(() => {
    const map: Record<string, EmailFollowUp[]> = {};
    for (const fu of followUps) {
      if (!fu.thread_id) continue; // unthreaded follow-ups aren't grouped by thread
      if (!map[fu.thread_id]) map[fu.thread_id] = [];
      map[fu.thread_id].push(fu);
    }
    return map;
  }, [followUps]);

  // ── Search + advanced filtering (state + derived thread lists) ──

  const filters = useInboxFilters({
    inboxThreads,
    sentThreads,
    trashThreads,
    hiddenThreads,
    emails,
    contactMap,
    followUpsByThread,
  });
  const {
    searchQuery,
    selectedContactId,
    showFilters,
    setShowFilters,
    filteredInboxThreads,
    filteredSentThreads,
    filteredTrashThreads,
    filteredHiddenThreads,
    activeFilterCount,
  } = filters;

  // ── Email expand (handles single-message auto-expand) ──

  const handleExpandEmail = async (gmailMessageId: string) => {
    if (expandedEmailId === gmailMessageId) {
      collapseEmail();
      return;
    }
    expandEmail(gmailMessageId);
    setLoadingEmailContent(true);
    // Claim the latest-expand token so a slower body fetch from a message the
    // user has since collapsed or switched away from can't overwrite this row
    // or clear the wrong spinner (CAR-145 / F19).
    const token = expandReq.begin();

    const allMsgs = [...emails, ...trashedEmails, ...hiddenEmails];
    const msg = allMsgs.find((e) => e.gmail_message_id === gmailMessageId);

    // Simulated emails have no Gmail counterpart — use DB data directly
    const isSimulated = !!(msg as Record<string, unknown>)?.is_simulated;

    if (msg && !msg.is_read) {
      setEmails((prev) => prev.map((e) => (e.gmail_message_id === gmailMessageId ? { ...e, is_read: true } : e)));
      // Only unread inbound mail decrements the nav badge (F18).
      emitUiEvent(UI_EVENTS.unreadChanged, { delta: unreadDeltaFor(msg) });
      // error-tolerated: mirrors Gmail's own read state rather than something
      // the user asked for, and the next sync re-derives it. The optimistic row
      // update above is what they see; a toast here would interrupt a read.
      await apiSend(`/api/gmail/emails/${gmailMessageId}/read`, { method: "POST" })
        .catch((err) => console.error("Failed to mark as read:", err));
      // Confirm badge count from server now that DB is updated
      emitUiEvent(UI_EVENTS.unreadChanged, { refetch: true });
    }

    if (isSimulated) {
      // Render simulated email content directly from the DB snippet
      if (expandReq.isLatest(token)) {
        setExpandedContent({
          subject: msg?.subject ?? "",
          from: msg?.from_address ?? "",
          to: msg?.to_addresses?.[0] ?? "",
          date: msg?.date ?? "",
          bodyHtml: `<p>${msg?.snippet ?? ""}</p>`,
          bodyText: msg?.snippet ?? "",
          messageId: gmailMessageId,
          gmailMessageId,
          threadId: msg?.thread_id ?? "",
        });
        setLoadingEmailContent(false);
      }
      return;
    }

    try {
      const data = await apiFetch<{ success?: boolean; message?: EmailMessageFull }>(
        `/api/gmail/emails/${gmailMessageId}`,
      );
      if (!expandReq.isLatest(token)) return;
      if (data.success && data.message) setExpandedContent(data.message);
    } catch (err) {
      console.error("Error loading email:", err);
    } finally {
      if (expandReq.isLatest(token)) setLoadingEmailContent(false);
    }
  };

  const handleThreadClick = (thread: EmailThread) => {
    if (expandedThreadId === thread.threadId) {
      collapseAll();
      return;
    }

    expandThread(thread.threadId);

    // Single message => auto-expand its content. Multi-message threads stay at
    // the message list (expandThread already cleared any prior selection).
    if (thread.messages.length === 1) {
      // handleExpandEmail owns its error/loading state, so this is fire-and-forget.
      void handleExpandEmail(thread.messages[0].gmail_message_id);
    }
  };

  // ── Email actions ──

  // Each mutation is optimistic: it mutates local lists immediately, then
  // reconciles with the server. On failure it restores the captured item to its
  // original list, reverses any badge adjustment, and toasts (CAR-150 / F21).

  const handleTrashEmail = async (gmailMessageId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const trashed = emails.find((em) => em.gmail_message_id === gmailMessageId);
    if (!trashed) return;
    setEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
    setTrashedEmails((prev) => [{ ...trashed, is_trashed: true }, ...prev]);
    if (expandedEmailId === gmailMessageId) collapseEmail();
    const delta = unreadDeltaFor(trashed);
    emitUiEvent(UI_EVENTS.unreadChanged, { delta });
    try {
      await apiSend(`/api/gmail/emails/${gmailMessageId}/trash`, { method: "POST" });
    } catch {
      setTrashedEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
      setEmails((prev) => [trashed, ...prev]);
      if (delta !== 0) emitUiEvent(UI_EVENTS.unreadChanged, { delta: -delta });
      toastError("Couldn't move that email to trash. Please try again.");
    }
  };

  const handleRestoreEmail = async (gmailMessageId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const restored = trashedEmails.find((em) => em.gmail_message_id === gmailMessageId);
    if (!restored) return;
    setTrashedEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
    setEmails((prev) => [{ ...restored, is_trashed: false }, ...prev]);
    if (expandedEmailId === gmailMessageId) collapseEmail();
    // Restoring unread inbound mail brings its unread count back — the inverse
    // of the trash decrement (F18: this path emitted nothing before).
    const delta = -unreadDeltaFor(restored);
    emitUiEvent(UI_EVENTS.unreadChanged, { delta });
    try {
      await apiSend(`/api/gmail/emails/${gmailMessageId}/trash`, { method: "DELETE" });
    } catch {
      setEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
      setTrashedEmails((prev) => [restored, ...prev]);
      if (delta !== 0) emitUiEvent(UI_EVENTS.unreadChanged, { delta: -delta });
      toastError("Couldn't restore that email. Please try again.");
    }
  };

  const handleHideEmail = async (gmailMessageId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const hidden = emails.find((em) => em.gmail_message_id === gmailMessageId);
    if (!hidden) return;
    setEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
    setHiddenEmails((prev) => [{ ...hidden, is_hidden: true }, ...prev]);
    if (expandedEmailId === gmailMessageId) collapseEmail();
    const delta = unreadDeltaFor(hidden);
    emitUiEvent(UI_EVENTS.unreadChanged, { delta });
    try {
      await apiSend(`/api/gmail/emails/${gmailMessageId}/hide`, { method: "POST" });
    } catch {
      setHiddenEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
      setEmails((prev) => [hidden, ...prev]);
      if (delta !== 0) emitUiEvent(UI_EVENTS.unreadChanged, { delta: -delta });
      toastError("Couldn't hide that email. Please try again.");
    }
  };

  const handleUnhideEmail = async (gmailMessageId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const unhidden = hiddenEmails.find((em) => em.gmail_message_id === gmailMessageId);
    if (!unhidden) return;
    setHiddenEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
    setEmails((prev) => [{ ...unhidden, is_hidden: false }, ...prev]);
    if (expandedEmailId === gmailMessageId) collapseEmail();
    // Unhiding unread inbound mail brings its unread count back (F18: this path
    // emitted nothing before).
    const delta = -unreadDeltaFor(unhidden);
    emitUiEvent(UI_EVENTS.unreadChanged, { delta });
    try {
      await apiSend(`/api/gmail/emails/${gmailMessageId}/hide`, { method: "DELETE" });
    } catch {
      setEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
      setHiddenEmails((prev) => [unhidden, ...prev]);
      if (delta !== 0) emitUiEvent(UI_EVENTS.unreadChanged, { delta: -delta });
      toastError("Couldn't unhide that email. Please try again.");
    }
  };

  const handleMoveEmail = async (gmailMessageId: string, labelId: string) => {
    const moved = emails.find((em) => em.gmail_message_id === gmailMessageId);
    if (!moved) return;
    setEmails((prev) => prev.filter((em) => em.gmail_message_id !== gmailMessageId));
    if (expandedEmailId === gmailMessageId) collapseEmail();
    // Moving out of the inbox may change the unread count; let the badge re-pull
    // the authoritative number.
    emitUiEvent(UI_EVENTS.unreadChanged);
    try {
      await apiSend(`/api/gmail/emails/${gmailMessageId}/move`, jsonBody({ labelId }));
    } catch {
      setEmails((prev) => [moved, ...prev]);
      emitUiEvent(UI_EVENTS.unreadChanged);
      toastError("Couldn't move that email. Please try again.");
    }
  };

  // ── Draft actions ──

  const deleteDraft = async (draftId: number) => {
    // Unlike the email lists (re-sorted by buildThreads), DraftsTab renders the
    // drafts array verbatim, so a failed-delete rollback must restore the draft
    // at its original index to preserve updated_at order.
    const removedIndex = drafts.findIndex((d) => d.id === draftId);
    if (removedIndex === -1) return;
    const removed = drafts[removedIndex];
    setDrafts((prev) => prev.filter((d) => d.id !== draftId));
    try {
      await apiSend(`/api/gmail/drafts/${draftId}`, { method: "DELETE" });
    } catch {
      setDrafts((prev) => {
        const next = [...prev];
        next.splice(Math.min(removedIndex, next.length), 0, removed);
        return next;
      });
      toastError("Couldn't delete that draft. Please try again.");
    }
  };

  const openDraft = (draft: EmailDraft) => {
    openCompose({
      to: draft.recipient_email || undefined,
      name: draft.contact_name || undefined,
      subject: draft.subject || undefined,
      bodyHtml: draft.body_html || undefined,
      threadId: draft.thread_id || undefined,
      inReplyTo: draft.in_reply_to || undefined,
      references: draft.references_header || undefined,
      draftId: draft.id,
    });
  };

  // ── Scheduled / Follow-up cancel ──

  const cancelScheduledEmail = async (id: number) => {
    // `if (res.ok)` with no else, so a refused cancel left the row queued and
    // said nothing: the user's next signal was the email arriving anyway. The
    // same shape CAR-183 fixed on the follow-up card (CAR-188).
    //
    // Guard + 409 passthrough are CAR-204. Without the guard a double-click
    // sends two DELETEs; the second finds status='cancelled', which the
    // cascade's `.in("status", [pending, failed])` filter excludes, so it 409s
    // and the toast reported failure on a cancel that landed. And when the cron
    // has genuinely claimed the row, "Please try again" is advice that cannot
    // succeed, so the route's own message says why instead.
    if (cancellingRef.current.has(id)) return;
    cancellingRef.current.add(id);
    const cancelled = await withToastOnError(
      () => apiSend(`/api/gmail/schedule/${id}`, { method: "DELETE" }),
      toastError,
      "Couldn't cancel that scheduled email. Please try again.",
      { preferServerMessageFor: [409] },
    );
    cancellingRef.current.delete(id);
    if (!cancelled) return;

    setScheduledEmails((prev) => prev.filter((e) => e.id !== id));
    setFollowUps((prev) => prev.filter((fu) => fu.scheduled_email_id !== id));
  };

  // A failed scheduled email (the send process died mid-flight, CAR-134) can
  // be requeued; the user decides, since the original may or may not have
  // actually gone out.
  const retryScheduledEmail = async (id: number) => {
    // Same shape as the cancel above: the retry route 409s with "This email is
    // not in a failed state." on a second call, so an unguarded double-click
    // flipped the row to Scheduled AND toasted that the retry failed (CAR-204).
    if (retryingRef.current.has(id)) return;
    retryingRef.current.add(id);
    const requeued = await withToastOnError(
      () => apiSend(`/api/gmail/schedule/${id}/retry`, { method: "POST" }),
      toastError,
      "Could not retry this email. Please try again.",
      { preferServerMessageFor: [409] },
    );
    retryingRef.current.delete(id);
    if (!requeued) return;

    // The cron is the sole send driver (CAR-139); the requeued email goes
    // out on the next tick (within ~15 minutes).
    setScheduledEmails((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: "pending" } : e)),
    );
  };

  const cancelFollowUp = async (followUpId: number) => {
    const cancelled = await withToastOnError(
      () => apiSend(`/api/gmail/follow-ups/${followUpId}`, { method: "DELETE" }),
      toastError,
      "Couldn't cancel that follow-up. Please try again.",
    );
    if (!cancelled) return;

    setFollowUps((prev) => prev.filter((fu) => fu.id !== followUpId));
  };

  // ── Date helpers ──

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday = d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const isThisYear = d.getFullYear() === now.getFullYear();
    if (isThisYear) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const formatDateFull = (dateStr: string) =>
    new Date(dateStr).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ── Not connected ──

  if (!loading && !gmailLoading && !gmailConnected) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <div className="w-18 h-18 rounded-full bg-primary-container flex items-center justify-center mx-auto mb-5">
            <Mail className="h-9 w-9 text-on-primary-container" />
          </div>
          <h2 className="text-2xl font-medium text-foreground mb-2">Connect your Gmail and Calendar</h2>
          <p className="text-base text-muted-foreground mb-6 max-w-md mx-auto">
            Connect Gmail to see your email conversations with contacts, send emails, and track follow-ups. Google Calendar connects on the same screen for scheduling.
          </p>
          <div className="max-w-md mx-auto mb-6 text-left">
            <OAuthWarning />
          </div>
          <Button
            href="/api/gmail/auth"
            onClick={() => trackBeforeNavigate("gmail_connect_clicked", { source: "inbox" })}
          >
            <Mail className="h-5 w-5 mr-2" />
            Connect Gmail & Calendar
          </Button>
        </div>
      </div>
    );
  }

  // Connected, but the inbox fetch failed. With nothing on screen to fall back
  // on, render a full-screen retryable error instead of the empty "No emails
  // synced yet." state; when an independently-loaded list (drafts, or prior
  // data) survived, a banner below flags the failure without wiping it out.
  // `!loadedOnce` scopes this to the INITIAL load: once a load has succeeded
  // (even empty), a transient refresh failure toasts instead of replacing the
  // known-good page (CAR-176 — mirrors the dashboard's coreLoadedOnce).
  if (loadError && !loading && !anyInboxData && !loadedOnce) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          {/* Retry re-asserts the spinner so the in-flight window doesn't
              render the misleading empty state (CAR-154 review). */}
          <LoadErrorState message="We could not load your inbox" onRetry={() => { setLoading(true); void loadInbox(); }} />
        </div>
      </div>
    );
  }

  // ── Sidebar counts ──

  const unreadEmailCount = emails.filter((e) => !e.is_read && e.direction === "inbound").length;
  const pendingFollowUpCount = followUps.reduce(
    (sum, fu) => sum + fu.email_follow_up_messages.filter((m) => isOpenFollowUpMessage(m.status)).length,
    0
  );


  // ── Sidebar items ──

  const sidebarItems: SidebarItem[] = [
    { key: "inbox", label: "Inbox", icon: Inbox, count: unreadEmailCount },
    { key: "sent", label: "Sent", icon: Send, count: 0 },
    { key: "drafts", label: "Drafts", icon: FileText, count: drafts.length },
    { key: "scheduled", label: "Scheduled", icon: Clock, count: scheduledEmails.length },
    { key: "followups", label: "Follow-ups", icon: Clock, count: pendingFollowUpCount },
    { key: "trash", label: "Trash", icon: Trash2, count: trashedEmails.length },
    { key: "hidden", label: "Hidden", icon: EyeOff, count: hiddenEmails.length },
  ];

  const switchTab = (key: SidebarTab) => {
    setActiveTab(key);
    // Collapsing on tab change is the single reset path — a behavioral test
    // guards this line (CAR-150). The child tab's transient UI state (open
    // dropdowns/menus) resets on its own because it unmounts here.
    collapseAll();
  };

  // Props every ThreadListTab instance shares (the four mailbox views differ
  // only by their thread list + tabCtx).
  const threadListProps = {
    expandedThreadId,
    expandedEmailId,
    expandedEmailContent,
    loadingEmailContent,
    onThreadClick: handleThreadClick,
    onExpandEmail: handleExpandEmail,
    contactMap,
    gmailLabels,
    followUpsByThread,
    calendarByThread,
    onTrash: handleTrashEmail,
    onRestore: handleRestoreEmail,
    onHide: handleHideEmail,
    onUnhide: handleUnhideEmail,
    onMove: handleMoveEmail,
    onViewContact: (contactId: number) => router.push(`/contacts/${contactId}`),
    onOpenFollowUp: setFollowUpModal,
    searchQuery,
    selectedContactId,
    activeFilterCount,
    formatDate,
    formatDateFull,
  };

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="px-4 sm:px-6 lg:px-8 py-5">
        <InboxTopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          searchQuery={searchQuery}
          onSearchChange={filters.setSearchQuery}
          onToggleFilters={() => setShowFilters(!showFilters)}
          activeFilterCount={activeFilterCount}
          syncing={syncing}
          onSync={handleSync}
          onCompose={() => openCompose()}
        />

        {showFilters && (
          <InboxFilterBar
            filterDirection={filters.filterDirection}
            setFilterDirection={filters.setFilterDirection}
            filterDays={filters.filterDays}
            setFilterDays={filters.setFilterDays}
            filterThreadType={filters.filterThreadType}
            setFilterThreadType={filters.setFilterThreadType}
            filterFollowUp={filters.filterFollowUp}
            setFilterFollowUp={filters.setFilterFollowUp}
            selectedContactId={selectedContactId}
            setSelectedContactId={filters.setSelectedContactId}
            contactSearchQuery={filters.contactSearchQuery}
            setContactSearchQuery={filters.setContactSearchQuery}
            contactMap={contactMap}
            filteredContactOptions={filters.filteredContactOptions}
            activeFilterCount={activeFilterCount}
            clearAllFilters={filters.clearAllFilters}
          />
        )}

        <div className="flex gap-5">
          <InboxSidebar items={sidebarItems} activeTab={activeTab} onSwitchTab={switchTab} sidebarOpen={sidebarOpen} />

          {/* ── Main content ── */}
          <div className="flex-1 min-w-0">
            <InboxMobileTabs items={sidebarItems} activeTab={activeTab} onSwitchTab={switchTab} />

            {/* Partial failure: the inbox payload failed but an independent
                list (drafts, or previously loaded data) is on screen. Flag it
                inline instead of silently masking the failure behind the
                surviving content (CAR-154 review F4). */}
            {loadError && !loading && anyInboxData && (
              <LoadErrorBanner
                message="Some of your inbox could not be loaded."
                onRetry={() => { void loadInbox(); }}
                className="mb-4"
              />
            )}

            {loading ? (
              <div className="flex items-center justify-center gap-3.5 text-muted-foreground py-16">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
                <span className="text-base">Loading inbox…</span>
              </div>
            ) : (
              /* One tab panel throwing must not blank the whole inbox (CAR-184).
                 Keyed by activeTab because the boundary self-clears on pathname
                 change and switching tabs is same-route state, so without the key
                 a tripped Drafts panel would keep showing the error after the
                 user switched back to Inbox.

                 onReset re-asserts the spinner before re-fetching, the same
                 closure the LoadErrorState retry above uses. That matters twice:
                 it makes "Try again" actually re-fetch, and because `loading`
                 gates this whole branch, setting it unmounts the boundary and so
                 discards a stale error once good data lands. loadInbox alone
                 would not (it deliberately never sets loading=true), which is
                 what would otherwise leave the panel stuck after a Sync. */
              <SectionBoundary
                key={activeTab}
                label={`inbox-tab:${activeTab}`}
                onReset={() => { setLoading(true); void loadInbox(); }}
              >
                {activeTab === "inbox" && <ThreadListTab threads={filteredInboxThreads} tabCtx="inbox" {...threadListProps} />}
                {activeTab === "sent" && <ThreadListTab threads={filteredSentThreads} tabCtx="sent" {...threadListProps} />}
                {activeTab === "trash" && <ThreadListTab threads={filteredTrashThreads} tabCtx="trash" {...threadListProps} />}
                {activeTab === "hidden" && <ThreadListTab threads={filteredHiddenThreads} tabCtx="hidden" {...threadListProps} />}

                {activeTab === "drafts" && (
                  <DraftsTab drafts={drafts} onOpenDraft={openDraft} onDeleteDraft={deleteDraft} formatDate={formatDate} />
                )}

                {activeTab === "scheduled" && (
                  <ScheduledTab
                    scheduledEmails={scheduledEmails}
                    followUps={followUps}
                    contactMap={contactMap}
                    onRetry={retryScheduledEmail}
                    onCancel={cancelScheduledEmail}
                    onOpenFollowUp={setFollowUpModal}
                    formatDateFull={formatDateFull}
                  />
                )}

                {activeTab === "followups" && (
                  <FollowUpsTab
                    followUps={followUps}
                    onCancel={cancelFollowUp}
                    onOpenFollowUp={setFollowUpModal}
                    formatDateFull={formatDateFull}
                  />
                )}
              </SectionBoundary>
            )}
          </div>
        </div>
      </div>

      <FollowUpModal
        isOpen={!!followUpModal}
        onClose={() => { setFollowUpModal(null); void loadInbox(); }}
        recipientEmail={followUpModal?.recipientEmail || ""}
        contactName={followUpModal?.contactName || null}
        originalSubject={followUpModal?.originalSubject || ""}
        originalSentAt={followUpModal?.originalSentAt || new Date().toISOString()}
        originalGmailMessageId={followUpModal?.originalGmailMessageId || ""}
        threadId={followUpModal?.threadId || ""}
        scheduledEmailId={followUpModal?.scheduledEmailId}
        existingFollowUp={followUpModal?.existingFollowUp}
      />
    </div>
  );
}
