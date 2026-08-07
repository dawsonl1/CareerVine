"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { UI_EVENTS, onUiEvent } from "@/lib/ui-events";
import { useParams, useRouter } from "next/navigation";
import { hasInAppBackHistory } from "@/lib/nav-history";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useLatestRequest } from "@/hooks/use-latest-request";
import Navigation from "@/components/navigation";
import { getContactById, getContacts, getMeetingsForContact, getActionItemsForContact, getCompletedActionItemsForContact, getInteractions, getAttachmentsForContact, getGmailConnection } from "@/lib/queries";
import type { Contact, ContactMeeting, InteractionRow, GmailConnection, EmailMessage, ScheduledEmail, TimelineEntry } from "@/lib/types";
import { ContactProfileCard } from "@/components/contacts/contact-profile-card";
import { ContactAboutCard } from "@/components/contacts/contact-about-card";
import { ContactExperienceCard } from "@/components/contacts/contact-experience-card";
import { ContactFollowUpStatus } from "@/components/contacts/contact-follow-up-status";
import { ContactQuickActions } from "@/components/contacts/contact-quick-actions";
import { ContactEditModal } from "@/components/contacts/contact-edit-modal";
import { ContactActionsTab } from "@/components/contacts/contact-actions-tab";
import { ContactTimelineTab } from "@/components/contacts/contact-timeline-tab";
import { TimelineDetailModal } from "@/components/contacts/timeline-detail-modal";
import { ContactEmailsTab } from "@/components/contacts/contact-emails-tab";
import { ContactAttachmentsTab } from "@/components/contacts/contact-attachments-tab";
import { ContactPendingActionsBanner } from "@/components/contacts/contact-pending-actions-banner";
import { ChevronLeft } from "lucide-react";
import { useQuickCapture } from "@/components/quick-capture-context";
import { deleteContact } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";
import { SectionBoundary } from "@/components/ui/section-boundary";
import { LoadErrorBanner, LoadErrorState } from "@/components/ui/load-error-state";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch, apiSend } from "@/lib/api-client";
import { withToastOnError } from "@/lib/with-toast-on-error";

type ActionItem = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  is_completed: boolean;
  meetings: { id: number; meeting_type: string | null; meeting_date: string } | null;
  action_item_contacts?: { contact_id: number; contacts: { id: number; name: string } | null }[];
};
type CompletedAction = {
  id: number;
  title: string;
  // description and direction cost nothing extra — getCompletedActionItemsForContact
  // selects `*` — and the timeline's detail view renders both (CAR-249).
  description: string | null;
  direction?: string | null;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  meetings: { id: number; meeting_type: string | null; meeting_date: string } | null;
};
type Attachment = {
  id: number;
  file_name: string;
  content_type: string | null;
  file_size_bytes: number | null;
  object_path: string;
  created_at: string | null;
};

const TABS = [
  { key: "timeline", label: "Timeline" },
  { key: "actions", label: "Actions" },
  { key: "emails", label: "Emails" },
  { key: "attachments", label: "Attachments" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function ContactDetailPage() {
  const { user } = useAuth();
  const { gmailConnected, gmailLoading } = useCompose();
  const { can } = useCapabilities();
  const { open: openQuickCapture } = useQuickCapture();
  const { success: toastSuccess, error: toastError } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const router = useRouter();
  const params = useParams();
  const contactId = Number(params.id);

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * The user's whole contact list, for the ContactPicker inside the Actions
   * tab's inline edit form — the ONLY thing on a one-contact page that needs it.
   * Fetched when that tab opens, never on mount (CAR-229): it is ~2,000 rows
   * dragging every joined email, phone, company, school and tag, and it was by
   * some distance the slowest request this page made.
   */
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const contactsRequested = useRef(false);
  const [editing, setEditing] = useState(false);

  const [meetings, setMeetings] = useState<ContactMeeting[]>([]);
  const [interactions, setInteractions] = useState<InteractionRow[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [completedActions, setCompletedActions] = useState<CompletedAction[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [relatedLoadFailed, setRelatedLoadFailed] = useState(false);
  /**
   * Whether a related-data read has ever succeeded. The `!detail` analogue from
   * the outreach page cannot be "are the arrays empty" here, because a contact
   * with genuinely no meetings, actions or attachments is indistinguishable from
   * one whose read never landed, and those two need opposite renders.
   */
  const [relatedLoaded, setRelatedLoaded] = useState(false);
  // Increments on every completed loadRelatedData; feeds the tab boundary's key so
  // fresh data clears a stale error panel (CAR-184, see loadRelatedData).
  const [dataGeneration, setDataGeneration] = useState(0);

  /**
   * The timeline row whose detail modal is open (CAR-249). Held HERE rather than
   * in the tab: the tab sits inside a `SectionBoundary` keyed on
   * `dataGeneration`, which every completed background refresh bumps, so a modal
   * owned down there is unmounted mid-interaction — the same defect CAR-204
   * fixed for the delete confirmation.
   */
  const [detailEntry, setDetailEntry] = useState<TimelineEntry | null>(null);

  /**
   * Which timeline email threads the user has expanded (CAR-260). Held here for
   * the same reason as `detailEntry` directly above: the tab is remounted by
   * every `dataGeneration` bump, so a thread opened by the user would collapse
   * under them the moment a background refresh landed.
   */
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const toggleThread = useCallback((threadId: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (!next.delete(threadId)) next.add(threadId);
      return next;
    });
  }, []);

  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [contactEmails, setContactEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [emailsLoadFailed, setEmailsLoadFailed] = useState(false);
  const [scheduledLoadFailed, setScheduledLoadFailed] = useState(false);
  const cancellingRef = useRef<Set<number>>(new Set());

  // Tab state with hash persistence
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window !== "undefined") {
      const hash = window.location.hash.replace("#", "") as TabKey;
      if (TABS.some((t) => t.key === hash)) return hash;
    }
    return "timeline";
  });

  const changeTab = (tab: TabKey) => {
    setActiveTab(tab);
    window.history.replaceState(null, "", `#${tab}`);
  };

  /**
   * Idempotent via a ref rather than `allContacts.length`, so re-entering the
   * tab cannot re-fire it and an empty list is not mistaken for "never tried";
   * the ref is released on failure so the next open retries.
   */
  const ensureAllContacts = useCallback(async () => {
    if (!user || contactsRequested.current) return;
    contactsRequested.current = true;
    try {
      // getContacts is properly typed as of CAR-158; no assertion needed.
      setAllContacts(await getContacts(user.id));
    } catch (e) {
      contactsRequested.current = false;
      console.error("Error loading contacts:", e);
    }
  }, [user]);

  const loadContact = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getContactById(contactId, user.id);
      setContact(data as Contact);
    } catch {
      router.push("/contacts");
    } finally {
      setLoading(false);
    }
  }, [user, contactId, router]);

  // Four call sites invoke this on one mount — the [contact] effect, the
  // conversationLogged listener, onActionCompleted and onReset — so completing
  // two action items in quick succession puts two reads in flight and the
  // loser, landing last, puts a completed item back in the open list. Its
  // `finally` also bumps dataGeneration, remounting the tab boundary onto stale
  // data, which is the same failure the outreach page's gate exists to stop
  // (CAR-190 review).
  const relatedRequest = useLatestRequest();

  const loadRelatedData = useCallback(async () => {
    const token = relatedRequest.begin();
    setLoadingData(true);
    setRelatedLoadFailed(false);
    try {
      const [mtgs, acts, completed, ints, atts] = await Promise.all([
        getMeetingsForContact(contactId),
        getActionItemsForContact(contactId),
        getCompletedActionItemsForContact(contactId),
        getInteractions(contactId),
        getAttachmentsForContact(contactId),
      ]);
      if (!relatedRequest.isLatest(token)) return;
      setMeetings(mtgs);
      setActions(acts as ActionItem[]);
      setCompletedActions(completed as CompletedAction[]);
      setInteractions(ints);
      setAttachments(atts as Attachment[]);
      setRelatedLoaded(true);
    } catch (e) {
      if (!relatedRequest.isLatest(token)) return;
      console.error("Error loading contact data:", e);
      // Section f. Every state this read owns keeps its previous value on a
      // throw — on mount that is `[]`, so the Actions, Timeline and Attachments
      // tabs each rendered their load-empty copy over a failed read: "no open
      // action items" for a contact who has them is exactly the confident lie
      // the user acts on (CAR-205).
      //
      // All FIVE callers are the "must surface" case: the mount effect, two
      // explicit retries (the boundary's Try again and the error panel's), and
      // two re-reads that follow a SUCCESSFUL write (onActionCompleted, and the
      // conversationLogged event, both of which fire only after their write
      // resolves). Nothing here re-reads after a failed write, so there is no
      // silent-resync case to carve out and no `mode` parameter to add.
      //
      // Surfacing is required; surfacing DESTRUCTIVELY is not (CAR-205 review).
      // None of these arrays is cleared on a throw, so a failed resync still has
      // valid content on screen, and `relatedLoaded` is what separates that from
      // a first load with nothing to keep. Same split, same reasoning and the
      // same two components as the outreach page in this branch.
      setRelatedLoadFailed(true);
    } finally {
      // Guarded by an `if` rather than an early return: a `return` inside
      // `finally` discards any in-flight exception.
      if (relatedRequest.isLatest(token)) {
        setLoadingData(false);
        // Bump the generation so the tab SectionBoundary remounts on fresh data
        // (CAR-184). Unlike the inbox and calendar, `loadingData` is passed to the
        // tabs as a prop rather than gating them, so nothing here unmounts the
        // boundary during a refresh: without this, a tripped tab would keep
        // showing its error panel even after correct data arrived, and "Try again"
        // could never recover. In the finally block on purpose, so a failed load
        // also re-evaluates rather than pinning the panel forever.
        setDataGeneration((g) => g + 1);
      }
    }
  }, [contactId, relatedRequest]);

  /**
   * The scheduled read was unchecked: a non-2xx `{ error }` body fell through
   * `scheduledData.scheduledEmails || []` to an empty list, so a failed read
   * looked like "nothing is scheduled" for a contact who has queued sends
   * (CAR-188).
   *
   * The two reads settle INDEPENDENTLY (CAR-204). Under `Promise.all` a failed
   * schedule read rejected the pair, so a successful email read was discarded
   * and the banner claimed "Couldn't load this contact's email history" — false,
   * and the emails had actually arrived. Worse, `contactEmails` also feeds the
   * Timeline tab, which has no failure prop, so it rendered a relationship
   * history with every email missing and no sign anything had gone wrong. That
   * is the same confident lie this work exists to remove, just relocated.
   *
   * The token guard is the other half: this owns a persistent user-visible flag
   * now, and it is called from the mount effect, the emailSent listener, four
   * callbacks inside ContactEmailsTab, and the banner's own Retry. Without it a
   * slow loser resolving after a fast winner strands the banner over good data.
   */
  const emailsReq = useLatestRequest();
  const loadContactEmails = useCallback(async () => {
    if (!gmailConn) return;
    const token = emailsReq.begin();
    setLoadingEmails(true);
    setContactEmails([]);
    setScheduledEmails([]);

    const [emailsResult, scheduledResult] = await Promise.allSettled([
      apiFetch<{ success?: boolean; emails?: EmailMessage[] }>(
        `/api/gmail/emails?contactId=${contactId}`,
      ),
      apiFetch<{ scheduledEmails?: ScheduledEmail[] }>(
        `/api/gmail/schedule?contactId=${contactId}`,
      ),
    ]);
    if (!emailsReq.isLatest(token)) return;

    if (emailsResult.status === "fulfilled" && emailsResult.value.success) {
      setContactEmails(emailsResult.value.emails || []);
    }
    if (scheduledResult.status === "fulfilled") {
      setScheduledEmails(scheduledResult.value.scheduledEmails || []);
    }
    // Only the emails read owns the tab's failure state, because only it backs
    // the thread list the banner's copy names. A failed schedule read is
    // reported by the scheduled block itself.
    setEmailsLoadFailed(emailsResult.status === "rejected");
    setScheduledLoadFailed(scheduledResult.status === "rejected");
    setLoadingEmails(false);
  }, [contactId, gmailConn, emailsReq]);

  useEffect(() => {
    if (user) {
      // Fire-and-forget: loadContact owns its error handling (redirects out on
      // a failed fetch), as do loadRelatedData and loadContactEmails below.
      void loadContact();
      getGmailConnection(user.id)
        .then((conn) => setGmailConn(conn as GmailConnection | null))
        .catch(() => {});
    }
  }, [user, loadContact]);

  // The Actions tab owns the only consumer of the full list, so opening it is
  // what pays for the fetch. Covers a direct load on #actions too, since
  // activeTab is seeded from the hash.
  useEffect(() => {
    if (contact && activeTab === "actions") void ensureAllContacts();
  }, [contact, activeTab, ensureAllContacts]);

  /**
   * The tab reads this contact's own name out of the list to label its
   * "Waiting on …" rows, so keep it in front: otherwise the label reads
   * "Waiting on them" until the fetch lands.
   */
  const actionsTabContacts = useMemo(
    () => (contact && !allContacts.some((c) => c.id === contact.id) ? [contact, ...allContacts] : allContacts),
    [contact, allContacts],
  );

  useEffect(() => {
    if (contact) void loadRelatedData();
  }, [contact, loadRelatedData]);

  useEffect(() => {
    if (contact && gmailConn) void loadContactEmails();
  }, [contact, gmailConn, loadContactEmails]);

  useEffect(() => {
    return onUiEvent(UI_EVENTS.emailSent, () => {
      if (gmailConn) {
        setTimeout(() => void loadContactEmails(), 500);
      }
    });
  }, [gmailConn, loadContactEmails]);

  useEffect(() => {
    return onUiEvent(UI_EVENTS.conversationLogged, () => { void loadRelatedData(); });
  }, [loadRelatedData]);

  const handleScheduledEmailCancel = async (scheduledId: number) => {
    // `if (res.ok) setState` with no else: a refused cancel left the row in
    // place and said nothing at all, so the user's only signal was the email
    // arriving later anyway (CAR-188).
    // Guard + 409 passthrough per CAR-204, matching inbox-shell's copy.
    if (cancellingRef.current.has(scheduledId)) return;
    cancellingRef.current.add(scheduledId);
    const cancelled = await withToastOnError(
      () => apiSend(`/api/gmail/schedule/${scheduledId}`, { method: "DELETE" }),
      toastError,
      "Couldn't cancel that scheduled email. Please try again.",
      { preferServerMessageFor: [409] },
    );
    cancellingRef.current.delete(scheduledId);
    if (!cancelled) return;

    setScheduledEmails((prev) => prev.filter((e) => e.id !== scheduledId));
  };

  const handleDelete = async () => {
    if (!contact) return;
    if (!(await confirm({
      message: "Are you sure you want to delete this contact? This cannot be undone.",
      title: "Delete contact",
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    try {
      await deleteContact(contact.id);
      toastSuccess(`${contact.name} deleted`);
      router.push("/contacts");
    } catch {
      toastError("Failed to delete contact");
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-4 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-base">Loading contact...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <p className="text-base text-muted-foreground">Contact not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Back link */}
        <div className="mb-6">
          <button
            onClick={() => {
              // Client-side route changes never update document.referrer,
              // so use the in-app nav trail instead: back() returns to
              // wherever the user came from (company page, contacts list,
              // …); direct loads fall back to the contacts list.
              if (hasInAppBackHistory()) {
                router.back();
              } else {
                router.push("/contacts");
              }
            }}
            className="inline-flex items-center gap-1.5 text-base text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <ChevronLeft className="h-5 w-5" />
            Back
          </button>
        </div>

        {/* Two-column layout */}
        <div className="flex flex-col md:flex-row gap-7">
          {/* Left sidebar */}
          <aside className="w-full md:w-80 md:shrink-0 space-y-5 md:sticky md:top-6 md:self-start">
            <ContactProfileCard
              contact={contact}
              userId={user!.id}
              onEdit={() => setEditing(true)}
              onDelete={handleDelete}
              onContactUpdate={loadContact}
            />
            <ContactAboutCard contact={contact} />
            <ContactExperienceCard contact={contact} />
            <ContactFollowUpStatus contactId={contactId} />
          </aside>

          {/* Main content */}
          <main className="flex-1 min-w-0 space-y-5">
            {/* Quick actions */}
            <ContactQuickActions
              contact={contact}
              onLogConversation={() => openQuickCapture(contactId)}
            />

            {/* Pending actions banner */}
            <ContactPendingActionsBanner
              actions={actions}
              onActionCompleted={loadRelatedData}
              onViewAll={() => changeTab("actions")}
            />

            {/* Tab bar */}
            <div className="flex gap-1.5 border-b border-outline-variant overflow-x-auto">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => changeTab(tab.key)}
                  className={`px-5 py-3 text-base font-medium transition-colors relative cursor-pointer whitespace-nowrap ${
                    activeTab === tab.key
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tab.label}
                  {activeTab === tab.key && (
                    <div className="absolute bottom-0 left-2 right-2 h-[3px] rounded-full bg-primary" />
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div>
              {/* A throw in one tab must leave the profile card, the tab bar and
                  the rest of the page intact (CAR-184). The key carries two
                  signals and both are load-bearing. activeTab: the boundary only
                  self-clears on a pathname change, and switching tabs here is
                  same-route state (it just rewrites the hash), so without it a
                  tripped Timeline tab would keep showing the error after the user
                  switched to Actions. dataGeneration: nothing on this page
                  unmounts the boundary during a refresh, so it is what lets fresh
                  data clear a stale panel and lets "Try again" recover at all. */}
              <SectionBoundary
                key={`${activeTab}:${dataGeneration}`}
                label={`contact-tab:${activeTab}`}
                onReset={() => void loadRelatedData()}
              >
              {/* Three of the four tabs render what loadRelatedData fetched, so a
                  failed read makes each of them claim the contact has no action
                  items, no history and no files. The Emails tab is excluded
                  because it reads from loadContactEmails, which owns its own
                  `emailsLoadFailed` / `scheduledLoadFailed` surfaces — hiding it
                  here would report a failure it did not have.

                  Note Timeline is a MIXED tab: it merges contactEmails in on top
                  of what this read owns, which is why it takes the emails
                  failure as its own banner below rather than being covered here.

                  Full state only when nothing has ever loaded. A resync failure
                  over content that is still on screen and still valid gets the
                  banner instead, exactly as on the outreach page — two of the
                  five callers are re-reads after a successful write, and wiping
                  the tab for those discards data the user can still use. */}
              {relatedLoadFailed && !relatedLoaded && activeTab !== "emails" ? (
                <LoadErrorState
                  message="Couldn't load this contact's activity."
                  onRetry={() => void loadRelatedData()}
                />
              ) : (
                <>
                {relatedLoadFailed && relatedLoaded && activeTab !== "emails" && (
                  <LoadErrorBanner
                    className="mb-4"
                    message="Couldn't refresh this contact's activity. Showing what was already loaded."
                    onRetry={() => void loadRelatedData()}
                  />
                )}
                {activeTab === "actions" && (
                  <ContactActionsTab
                    contactId={contactId}
                    userId={user!.id}
                    actions={actions}
                    completedActions={completedActions}
                    allContacts={actionsTabContacts}
                    meetings={meetings}
                    loading={loadingData}
                    onActionsChange={(acts, completed) => {
                      setActions(acts);
                      setCompletedActions(completed);
                    }}
                  />
                )}
                {activeTab === "timeline" && (
                  <ContactTimelineTab
                    meetings={meetings}
                    interactions={interactions}
                    emails={contactEmails}
                    completedActions={completedActions}
                    loading={loadingData}
                    emailsLoadFailed={emailsLoadFailed}
                    onReloadEmails={loadContactEmails}
                    onEntryClick={setDetailEntry}
                    expandedThreads={expandedThreads}
                    onToggleThread={toggleThread}
                  />
                )}
                {activeTab === "emails" && (
                  gmailConn ? (
                    <ContactEmailsTab
                      contactId={contactId}
                      contactName={contact.name}
                      contactEmails={contact.contact_emails.map((e) => e.email || "").filter(Boolean)}
                      emails={contactEmails}
                      scheduledEmails={scheduledEmails}
                      gmailConnected={gmailConnected}
                      canReadMailbox={can("mailbox:read")}
                      loadingEmails={loadingEmails}
                      emailsLoadFailed={emailsLoadFailed}
                      scheduledLoadFailed={scheduledLoadFailed}
                      onScheduledEmailCancel={handleScheduledEmailCancel}
                      onReloadEmails={loadContactEmails}
                    />
                  ) : gmailLoading ? (
                    <div className="py-8 flex justify-center">
                      <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-base text-muted-foreground mb-2">Gmail not connected.</p>
                      <p className="text-sm text-muted-foreground">
                        Connect your Gmail account in{" "}
                        <button onClick={() => router.push("/settings")} className="text-primary hover:underline cursor-pointer">Settings</button>
                        {" "}to view email history.
                      </p>
                    </div>
                  )
                )}
                {activeTab === "attachments" && (
                  <ContactAttachmentsTab
                    contactId={contactId}
                    userId={user!.id}
                    attachments={attachments}
                    loading={loadingData}
                    onAttachmentsChange={setAttachments}
                    // Asked by the page for the same reason as the timeline tab
                    // above: this boundary's key carries dataGeneration, so a
                    // useConfirm inside the tab is unmounted by any background
                    // refresh and the open dialog vanishes mid-question.
                    onConfirmDelete={() => confirm({
                      message: "This permanently deletes the file. It cannot be undone.",
                      title: "Delete attachment?",
                      confirmLabel: "Delete",
                      destructive: true,
                    })}
                  />
                )}
                </>
              )}
              </SectionBoundary>
            </div>
          </main>
        </div>

        {/* Edit modal */}
        <ContactEditModal
          isOpen={editing}
          contact={contact}
          userId={user!.id}
          onClose={() => setEditing(false)}
          onContactUpdate={loadContact}
          onContactDelete={handleDelete}
        />

        {/* Timeline detail. Deliberately OUTSIDE the SectionBoundary above:
            its key carries dataGeneration, so a modal rendered in there is
            unmounted by any background refresh that lands while the user is
            reading or editing (CAR-204's shape, CAR-249). */}
        <TimelineDetailModal
          entry={detailEntry}
          contactName={contact.name}
          canReadMailbox={can("mailbox:read")}
          gmailConnected={gmailConnected}
          onClose={() => setDetailEntry(null)}
          onChanged={() => {
            void loadRelatedData();
            void loadContactEmails();
          }}
          onConfirmDelete={({ message, title }) => confirm({
            message,
            title,
            confirmLabel: "Delete",
            destructive: true,
          })}
        />
      </div>
      {confirmDialog}
    </div>
  );
}
