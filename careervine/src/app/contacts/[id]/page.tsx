"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import Navigation from "@/components/navigation";
import { getContactById, getContacts, getMeetingsForContact, getActionItemsForContact, getCompletedActionItemsForContact, getInteractions, getAttachmentsForContact, getGmailConnection } from "@/lib/queries";
import type { Contact, ContactMeeting, InteractionRow, GmailConnection, EmailMessage, ScheduledEmail } from "@/lib/types";
import { ContactInfoHeader } from "@/components/contacts/contact-info-header";
import { ContactActionsTab } from "@/components/contacts/contact-actions-tab";
import { ContactTimelineTab } from "@/components/contacts/contact-timeline-tab";
import { ContactEmailsTab } from "@/components/contacts/contact-emails-tab";
import { ContactMeetingsTab } from "@/components/contacts/contact-meetings-tab";
import { ContactAttachmentsTab } from "@/components/contacts/contact-attachments-tab";
import { ChevronLeft } from "lucide-react";

type ActionItem = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  is_completed: boolean;
  meetings: { id: number; meeting_type: string; meeting_date: string } | null;
  action_item_contacts?: { contact_id: number; contacts: { id: number; name: string } | null }[];
};
type CompletedAction = {
  id: number;
  title: string;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  meetings: { id: number; meeting_type: string; meeting_date: string } | null;
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
  { key: "actions", label: "Action Items" },
  { key: "timeline", label: "Timeline" },
  { key: "emails", label: "Emails" },
  { key: "meetings", label: "Meetings" },
  { key: "attachments", label: "Attachments" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function ContactDetailPage() {
  const { user } = useAuth();
  const { gmailConnected } = useCompose();
  const router = useRouter();
  const params = useParams();
  const contactId = Number(params.id);

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);

  const [meetings, setMeetings] = useState<ContactMeeting[]>([]);
  const [interactions, setInteractions] = useState<InteractionRow[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [completedActions, setCompletedActions] = useState<CompletedAction[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  const [gmailConn, setGmailConn] = useState<GmailConnection | null>(null);
  const [contactEmails, setContactEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(false);

  // Tab state with hash persistence
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window !== "undefined") {
      const hash = window.location.hash.replace("#", "") as TabKey;
      if (TABS.some((t) => t.key === hash)) return hash;
    }
    return "actions";
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
    }
  }, [contactId]);

  const loadContactEmails = useCallback(async () => {
    if (!gmailConn) return;
    setLoadingEmails(true);
    setContactEmails([]);
    setScheduledEmails([]);
    try {
      const [emailsRes, scheduledRes] = await Promise.all([
        fetch(`/api/gmail/emails?contactId=${contactId}`),
        fetch(`/api/gmail/schedule?contactId=${contactId}`),
      ]);
      const emailsData = await emailsRes.json();
      const scheduledData = await scheduledRes.json();
      if (emailsData.success) setContactEmails(emailsData.emails || []);
      setScheduledEmails(scheduledData.scheduledEmails || []);
    } catch (err) {
      console.error("Error loading emails:", err);
    } finally {
      setLoadingEmails(false);
    }
  }, [contactId, gmailConn]);

  useEffect(() => {
    if (user) {
      loadContact();
      getGmailConnection(user.id)
        .then((conn) => {
          setGmailConn(conn as GmailConnection | null);
          if (conn) {
            fetch("/api/gmail/schedule/process", { method: "POST" }).catch(() => {});
            fetch("/api/gmail/follow-ups/process", { method: "POST" }).catch(() => {});
          }
        })
        .catch(() => {});

      // Load all contacts for the action item contact picker
      getContacts(user.id).then((data) => setAllContacts(data as Contact[])).catch(() => {});
    }
  }, [user, loadContact]);

  useEffect(() => {
    if (contact) loadRelatedData();
  }, [contact, loadRelatedData]);

  useEffect(() => {
    if (contact && gmailConn) loadContactEmails();
  }, [contact, gmailConn, loadContactEmails]);

  // Re-fetch emails when a message is sent/scheduled from the compose modal
  useEffect(() => {
    const handler = () => {
      if (gmailConn) {
        setTimeout(() => loadContactEmails(), 500);
      }
    };
    window.addEventListener("careervine:email-sent", handler);
    return () => window.removeEventListener("careervine:email-sent", handler);
  }, [gmailConn, loadContactEmails]);

  const handleScheduledEmailCancel = async (scheduledId: number) => {
    try {
      const res = await fetch(`/api/gmail/schedule/${scheduledId}`, { method: "DELETE" });
      if (res.ok) setScheduledEmails((prev) => prev.filter((e) => e.id !== scheduledId));
    } catch (err) {
      console.error("Error cancelling scheduled email:", err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading contact…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <p className="text-sm text-muted-foreground">Contact not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Back link */}
        <button
          onClick={() => router.push("/contacts")}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 cursor-pointer"
        >
          <ChevronLeft className="h-4 w-4" />
          All contacts
        </button>

        {/* Contact info header */}
        <div className="mb-8">
          <ContactInfoHeader
            contact={contact}
            userId={user!.id}
            onContactUpdate={() => loadContact()}
            onContactDelete={() => router.push("/contacts")}
          />
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-outline-variant mb-6 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => changeTab(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative cursor-pointer whitespace-nowrap ${
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
                onScheduledEmailCancel={handleScheduledEmailCancel}
                onReloadEmails={loadContactEmails}
              />
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground mb-2">Gmail not connected.</p>
                <p className="text-xs text-muted-foreground">
                  Connect your Gmail account in{" "}
                  <button onClick={() => router.push("/settings")} className="text-primary hover:underline cursor-pointer">Settings</button>
                  {" "}to view email history.
                </p>
              </div>
            )
          )}
          {activeTab === "meetings" && (
            <ContactMeetingsTab
              contactId={contactId}
              meetings={meetings}
              loading={loadingData}
              onMeetingsChange={setMeetings}
            />
          )}
          {activeTab === "attachments" && (
            <ContactAttachmentsTab
              contactId={contactId}
              userId={user!.id}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
            />
          )}
        </div>
      </div>
    </div>
  );
}
