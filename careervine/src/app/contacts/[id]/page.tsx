"use client";

import { useState, useEffect, useCallback } from "react";
import { UI_EVENTS, onUiEvent } from "@/lib/ui-events";
import { useParams, useRouter } from "next/navigation";
import { hasInAppBackHistory } from "@/lib/nav-history";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import { useCapabilities } from "@/hooks/use-capabilities";
import Navigation from "@/components/navigation";
import { getContactById, getContacts, getMeetingsForContact, getActionItemsForContact, getCompletedActionItemsForContact, getInteractions, getAttachmentsForContact, getGmailConnection } from "@/lib/queries";
import type { Contact, ContactMeeting, InteractionRow, GmailConnection, EmailMessage, ScheduledEmail } from "@/lib/types";
import { ContactProfileCard } from "@/components/contacts/contact-profile-card";
import { ContactAboutCard } from "@/components/contacts/contact-about-card";
import { ContactExperienceCard } from "@/components/contacts/contact-experience-card";
import { ContactFollowUpStatus } from "@/components/contacts/contact-follow-up-status";
import { ContactQuickActions } from "@/components/contacts/contact-quick-actions";
import { ContactEditModal } from "@/components/contacts/contact-edit-modal";
import { ContactActionsTab } from "@/components/contacts/contact-actions-tab";
import { ContactTimelineTab } from "@/components/contacts/contact-timeline-tab";
import { ContactEmailsTab } from "@/components/contacts/contact-emails-tab";
import { ContactAttachmentsTab } from "@/components/contacts/contact-attachments-tab";
import { ContactPendingActionsBanner } from "@/components/contacts/contact-pending-actions-banner";
import { ChevronLeft } from "lucide-react";
import { useQuickCapture } from "@/components/quick-capture-context";
import { deleteContact } from "@/lib/queries";
import { useToast } from "@/components/ui/toast";
import { SectionBoundary } from "@/components/ui/section-boundary";
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
  const [allContacts, setAllContacts] = useState<Contact[]>([]);
  const [editing, setEditing] = useState(false);

  const [meetings, setMeetings] = useState<ContactMeeting[]>([]);
  const [interactions, setInteractions] = useState<InteractionRow[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [completedActions, setCompletedActions] = useState<CompletedAction[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  // Increments on every completed loadRelatedData; feeds the tab boundary's key so
  // fresh data clears a stale error panel (CAR-184, see loadRelatedData).
  const [dataGeneration, setDataGeneration] = useState(0);

  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [contactEmails, setContactEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [emailsLoadFailed, setEmailsLoadFailed] = useState(false);

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

  const loadRelatedData = useCallback(async () => {
    setLoadingData(true);
    try {
      const [mtgs, acts, completed, ints, atts] = await Promise.all([
        getMeetingsForContact(contactId),
        getActionItemsForContact(contactId),
        getCompletedActionItemsForContact(contactId),
        getInteractions(contactId),
        getAttachmentsForContact(contactId),
      ]);
      setMeetings(mtgs);
      setActions(acts as ActionItem[]);
      setCompletedActions(completed as CompletedAction[]);
      setInteractions(ints);
      setAttachments(atts as Attachment[]);
    } catch (e) {
      console.error("Error loading contact data:", e);
    } finally {
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
  }, [contactId]);

  const loadContactEmails = useCallback(async () => {
    if (!gmailConn) return;
    setLoadingEmails(true);
    setContactEmails([]);
    setScheduledEmails([]);
    try {
      // The scheduled read was unchecked: a non-2xx `{ error }` body fell
      // through `scheduledData.scheduledEmails || []` to an empty list, so a
      // failed read was indistinguishable from "nothing is scheduled" for a
      // contact who has queued sends (CAR-188).
      const [emailsData, scheduledData] = await Promise.all([
        apiFetch<{ success?: boolean; emails?: EmailMessage[] }>(
          `/api/gmail/emails?contactId=${contactId}`,
        ),
        apiFetch<{ scheduledEmails?: ScheduledEmail[] }>(
          `/api/gmail/schedule?contactId=${contactId}`,
        ),
      ]);
      if (emailsData.success) setContactEmails(emailsData.emails || []);
      setScheduledEmails(scheduledData.scheduledEmails || []);
      setEmailsLoadFailed(false);
    } catch {
      setEmailsLoadFailed(true);
    } finally {
      setLoadingEmails(false);
    }
  }, [contactId, gmailConn]);

  useEffect(() => {
    if (user) {
      // Fire-and-forget: loadContact owns its error handling (redirects out on
      // a failed fetch), as do loadRelatedData and loadContactEmails below.
      void loadContact();
      getGmailConnection(user.id)
        .then((conn) => setGmailConn(conn as GmailConnection | null))
        .catch(() => {});

      // getContacts is properly typed as of CAR-158; no assertion needed.
      getContacts(user.id).then((data) => setAllContacts(data)).catch(() => {});
    }
  }, [user, loadContact]);

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
    const cancelled = await withToastOnError(
      () => apiSend(`/api/gmail/schedule/${scheduledId}`, { method: "DELETE" }),
      toastError,
      "Couldn't cancel that scheduled email. Please try again.",
    );
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
              {activeTab === "actions" && (
                <ContactActionsTab
                  contactId={contactId}
                  userId={user!.id}
                  actions={actions}
                  completedActions={completedActions}
                  allContacts={allContacts}
                  meetings={meetings}
                  onActionsChange={(acts, completed) => {
                    setActions(acts);
                    setCompletedActions(completed);
                  }}
                />
              )}
              {activeTab === "timeline" && (
                <ContactTimelineTab
                  contactId={contactId}
                  meetings={meetings}
                  interactions={interactions}
                  emails={contactEmails}
                  completedActions={completedActions}
                  loading={loadingData}
                  onInteractionsChange={setInteractions}
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
                  onAttachmentsChange={setAttachments}
                />
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
      </div>
      {confirmDialog}
    </div>
  );
}
