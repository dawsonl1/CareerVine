"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import Navigation from "@/components/navigation";
import { FollowUpModal } from "@/components/follow-up-modal";
import type {
  EmailMessage,
  EmailMessageFull,
  EmailFollowUp,
  ScheduledEmail,
} from "@/lib/types";
import {
  Inbox,
  Clock,
  Send,
  ArrowUpRight,
  ArrowDownLeft,
  Reply,
  Search,
  RefreshCw,
  PenSquare,
  XCircle,
  Pencil,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Types ──

type EmailThread = {
  threadId: string;
  subject: string;
  messages: EmailMessage[];
  latestDate: string;
  latestDirection: string | null;
  contactId: number | null;
};

type SidebarTab = "inbox" | "scheduled" | "followups";

// ── Page ──

export default function InboxPage() {
  const { user } = useAuth();
  const router = useRouter();
  const { gmailConnected, openCompose } = useCompose();

  const [activeTab, setActiveTab] = useState<SidebarTab>("inbox");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  // Data
  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [followUps, setFollowUps] = useState<EmailFollowUp[]>([]);
  const [contactMap, setContactMap] = useState<Record<number, string>>({});
  const [gmailAddress, setGmailAddress] = useState("");

  // Thread expansion
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);
  const [expandedEmailContent, setExpandedEmailContent] = useState<EmailMessageFull | null>(null);
  const [loadingEmailContent, setLoadingEmailContent] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState("");

  // Follow-up modal
  const [followUpModal, setFollowUpModal] = useState<{
    recipientEmail: string;
    contactName: string | null;
    originalSubject: string;
    originalSentAt: string;
    originalGmailMessageId: string;
    threadId: string;
    scheduledEmailId?: number | null;
    existingFollowUp?: EmailFollowUp | null;
  } | null>(null);

  // ── Data loading ──

  const loadInbox = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail/inbox");
      const data = await res.json();
      if (data.success) {
        setEmails(data.emails || []);
        setScheduledEmails(data.scheduledEmails || []);
        setFollowUps(data.followUps || []);
        setContactMap(data.contactMap || {});
        setGmailAddress(data.gmailAddress || "");
      }
    } catch (err) {
      console.error("Failed to load inbox:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user && gmailConnected) loadInbox();
    else setLoading(false);
  }, [user, gmailConnected, loadInbox]);

  // Refresh when an email is sent from the compose modal
  useEffect(() => {
    const handler = () => setTimeout(() => loadInbox(), 500);
    window.addEventListener("careervine:email-sent", handler);
    return () => window.removeEventListener("careervine:email-sent", handler);
  }, [loadInbox]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/gmail/sync", { method: "POST" });
      await loadInbox();
    } catch {
    } finally {
      setSyncing(false);
    }
  };

  // ── Thread grouping ──

  const threads = useMemo<EmailThread[]>(() => {
    const map = new Map<string, EmailMessage[]>();
    for (const email of emails) {
      const tid = email.thread_id || email.gmail_message_id;
      if (!map.has(tid)) map.set(tid, []);
      map.get(tid)!.push(email);
    }
    const result: EmailThread[] = [];
    for (const [threadId, msgs] of map) {
      msgs.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());
      const latest = msgs[msgs.length - 1];
      result.push({
        threadId,
        subject: msgs[0].subject || "(no subject)",
        messages: msgs,
        latestDate: latest.date || "",
        latestDirection: latest.direction,
        contactId: msgs[0].matched_contact_id,
      });
    }
    result.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
    return result;
  }, [emails]);

  // ── Search filtering ──

  const filteredThreads = useMemo(() => {
    if (!searchQuery.trim()) return threads;
    const q = searchQuery.toLowerCase();
    return threads.filter(
      (t) =>
        t.subject.toLowerCase().includes(q) ||
        t.messages.some(
          (m) =>
            m.snippet?.toLowerCase().includes(q) ||
            m.from_address?.toLowerCase().includes(q) ||
            m.to_addresses?.some((a) => a.toLowerCase().includes(q))
        ) ||
        (t.contactId && contactMap[t.contactId]?.toLowerCase().includes(q))
    );
  }, [threads, searchQuery, contactMap]);

  // ── Follow-up lookup by threadId ──

  const followUpsByThread = useMemo(() => {
    const map: Record<string, EmailFollowUp[]> = {};
    for (const fu of followUps) {
      if (!map[fu.thread_id]) map[fu.thread_id] = [];
      map[fu.thread_id].push(fu);
    }
    return map;
  }, [followUps]);

  // ── Email expand ──

  const handleExpandEmail = async (gmailMessageId: string) => {
    if (expandedEmailId === gmailMessageId) {
      setExpandedEmailId(null);
      setExpandedEmailContent(null);
      return;
    }
    setExpandedEmailId(gmailMessageId);
    setExpandedEmailContent(null);
    setLoadingEmailContent(true);

    // Mark as read optimistically
    const msg = emails.find((e) => e.gmail_message_id === gmailMessageId);
    if (msg && !msg.is_read) {
      setEmails((prev) =>
        prev.map((e) => (e.gmail_message_id === gmailMessageId ? { ...e, is_read: true } : e))
      );
      fetch(`/api/gmail/emails/${gmailMessageId}/read`, { method: "POST" }).catch(() => {});
      window.dispatchEvent(new CustomEvent("careervine:unread-changed"));
    }

    try {
      const res = await fetch(`/api/gmail/emails/${gmailMessageId}`);
      const data = await res.json();
      if (data.success) setExpandedEmailContent(data.message);
    } catch (err) {
      console.error("Error loading email:", err);
    } finally {
      setLoadingEmailContent(false);
    }
  };

  // ── Scheduled email cancel ──

  const cancelScheduledEmail = async (id: number) => {
    try {
      const res = await fetch(`/api/gmail/schedule/${id}`, { method: "DELETE" });
      if (res.ok) {
        setScheduledEmails((prev) => prev.filter((e) => e.id !== id));
        setFollowUps((prev) => prev.filter((fu) => fu.scheduled_email_id !== id));
      }
    } catch (err) {
      console.error("Error cancelling scheduled email:", err);
    }
  };

  // ── Follow-up cancel ──

  const cancelFollowUp = async (followUpId: number) => {
    try {
      const res = await fetch(`/api/gmail/follow-ups/${followUpId}`, { method: "DELETE" });
      if (res.ok) setFollowUps((prev) => prev.filter((fu) => fu.id !== followUpId));
    } catch (err) {
      console.error("Error cancelling follow-up:", err);
    }
  };

  // ── Date formatting helpers ──

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

    const isThisYear = d.getFullYear() === now.getFullYear();
    if (isThisYear) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const formatDateFull = (dateStr: string) =>
    new Date(dateStr).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  // ── Not connected state ──

  if (!loading && !gmailConnected) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-primary-container flex items-center justify-center mx-auto mb-4">
            <Mail className="h-8 w-8 text-on-primary-container" />
          </div>
          <h2 className="text-xl font-medium text-foreground mb-2">Connect your Gmail</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-md mx-auto">
            Connect your Gmail account in Settings to see your email conversations with contacts.
          </p>
          <Button onClick={() => router.push("/settings")}>Go to Settings</Button>
        </div>
      </div>
    );
  }

  // ── Sidebar counts ──

  const unreadEmailCount = useMemo(
    () => emails.filter((e) => !e.is_read && e.direction === "inbound").length,
    [emails]
  );

  const pendingFollowUpCount = followUps.reduce(
    (sum, fu) => sum + fu.email_follow_up_messages.filter((m) => m.status === "pending").length,
    0
  );

  return (
    <div className="min-h-screen bg-background">
      <Navigation />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Top bar: search + actions */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search emails..."
              className="w-full h-10 pl-10 pr-4 bg-surface-container-low text-foreground rounded-full border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="h-10 w-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors cursor-pointer disabled:opacity-50"
            title="Sync emails"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          </button>
          <Button onClick={() => openCompose()} size="sm">
            <PenSquare className="h-4 w-4 mr-1.5" />
            Compose
          </Button>
        </div>

        <div className="flex gap-6">
          {/* Sidebar */}
          <div className="w-48 shrink-0 hidden md:block">
            <nav className="space-y-0.5">
              {([
                { key: "inbox" as SidebarTab, label: "Inbox", icon: Inbox, count: unreadEmailCount },
                { key: "scheduled" as SidebarTab, label: "Scheduled", icon: Send, count: scheduledEmails.length },
                { key: "followups" as SidebarTab, label: "Follow-ups", icon: Clock, count: pendingFollowUpCount },
              ]).map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.key;
                const isBold = item.key === "inbox" && item.count > 0;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setActiveTab(item.key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                      isActive
                        ? "bg-secondary-container text-on-secondary-container"
                        : "text-muted-foreground hover:text-foreground hover:bg-surface-container-low"
                    }`}
                  >
                    <Icon className="h-4.5 w-4.5" />
                    <span className="flex-1 text-left">{item.label}</span>
                    {item.count > 0 && (
                      <span className={`text-xs font-medium ${
                        isBold
                          ? "bg-destructive text-destructive-foreground rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center"
                          : isActive ? "text-on-secondary-container" : "text-muted-foreground"
                      }`}>
                        {item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Mobile tab bar */}
          <div className="md:hidden flex gap-1 -mx-4 px-4 mb-4 border-b border-outline-variant overflow-x-auto w-full absolute left-0 bg-background z-10" style={{ top: "auto" }}>
            {/* rendered below on mobile via separate section */}
          </div>

          {/* Main content */}
          <div className="flex-1 min-w-0">
            {/* Mobile tabs */}
            <div className="flex md:hidden gap-1 border-b border-outline-variant mb-4 overflow-x-auto">
              {([
                { key: "inbox" as SidebarTab, label: "Inbox", count: unreadEmailCount },
                { key: "scheduled" as SidebarTab, label: "Scheduled", count: scheduledEmails.length },
                { key: "followups" as SidebarTab, label: "Follow-ups", count: pendingFollowUpCount },
              ]).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setActiveTab(item.key)}
                  className={`px-4 py-2.5 text-sm font-medium transition-colors relative cursor-pointer whitespace-nowrap ${
                    activeTab === item.key ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {item.label}
                  {item.count > 0 && ` (${item.count})`}
                  {activeTab === item.key && (
                    <div className="absolute bottom-0 left-2 right-2 h-[3px] rounded-full bg-primary" />
                  )}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="flex items-center justify-center gap-3 text-muted-foreground py-16">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
                <span className="text-sm">Loading inbox…</span>
              </div>
            ) : (
              <>
                {/* ─── INBOX TAB ─── */}
                {activeTab === "inbox" && (
                  <div>
                    {filteredThreads.length === 0 ? (
                      <div className="text-center py-16">
                        <Inbox className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">
                          {searchQuery ? "No emails match your search." : "No emails synced yet."}
                        </p>
                        {!searchQuery && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Hit the sync button or send an email to get started.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
                        {filteredThreads.map((thread) => {
                          const isExpanded = expandedThreadId === thread.threadId;
                          const latest = thread.messages[thread.messages.length - 1];
                          const contactName = thread.contactId ? contactMap[thread.contactId] : null;
                          const isUnread = thread.messages.some((m) => !m.is_read && m.direction === "inbound");
                          const threadFUs = followUpsByThread[thread.threadId] || [];
                          const pendingFUCount = threadFUs.reduce(
                            (sum, fu) => sum + fu.email_follow_up_messages.filter((m) => m.status === "pending").length,
                            0
                          );

                          return (
                            <div key={thread.threadId} className={isExpanded ? "bg-surface-container-low/50" : ""}>
                              {/* Thread row */}
                              <button
                                type="button"
                                className={`w-full text-left px-4 py-3 hover:bg-surface-container-low transition-colors cursor-pointer ${
                                  isUnread ? "bg-primary/[0.04]" : ""
                                }`}
                                onClick={() => {
                                  setExpandedThreadId(isExpanded ? null : thread.threadId);
                                  setExpandedEmailId(null);
                                  setExpandedEmailContent(null);
                                }}
                              >
                                <div className="flex items-center gap-3">
                                  {/* Direction icon */}
                                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                                    latest.direction === "outbound"
                                      ? "bg-primary-container"
                                      : "bg-tertiary-container"
                                  }`}>
                                    {latest.direction === "outbound" ? (
                                      <ArrowUpRight className="h-3.5 w-3.5 text-on-primary-container" />
                                    ) : (
                                      <ArrowDownLeft className="h-3.5 w-3.5 text-on-tertiary-container" />
                                    )}
                                  </div>

                                  {/* Sender / contact */}
                                  <div className="w-36 shrink-0 truncate">
                                    <span className={`text-sm ${isUnread ? "font-semibold text-foreground" : "text-foreground"}`}>
                                      {contactName ||
                                        (latest.direction === "outbound"
                                          ? `To: ${latest.to_addresses?.[0] || "Unknown"}`
                                          : latest.from_address || "Unknown")}
                                    </span>
                                  </div>

                                  {/* Subject + snippet */}
                                  <div className="flex-1 min-w-0 flex items-center gap-2">
                                    <span className={`text-sm truncate ${isUnread ? "font-semibold text-foreground" : "text-foreground"}`}>
                                      {thread.subject}
                                    </span>
                                    {thread.messages.length > 1 && (
                                      <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-secondary-container text-[10px] font-medium text-on-secondary-container shrink-0">
                                        {thread.messages.length}
                                      </span>
                                    )}
                                    {pendingFUCount > 0 && (
                                      <span className="inline-flex items-center gap-0.5 h-4 px-1.5 rounded-full bg-tertiary-container/50 text-[10px] font-medium text-on-tertiary-container shrink-0">
                                        <Clock className="h-2.5 w-2.5" />
                                        {pendingFUCount}
                                      </span>
                                    )}
                                    <span className="text-xs text-muted-foreground truncate hidden sm:inline">
                                      — {latest.snippet || ""}
                                    </span>
                                  </div>

                                  {/* Date */}
                                  <span className={`text-xs shrink-0 ${isUnread ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                                    {thread.latestDate ? formatDate(thread.latestDate) : ""}
                                  </span>
                                </div>
                              </button>

                              {/* Expanded thread */}
                              {isExpanded && (
                                <div className="px-4 pb-3">
                                  <div className="ml-4 border-l-2 border-outline-variant/50 pl-4 space-y-1 pt-1">
                                    {thread.messages.map((msg) => {
                                      const isMsgExpanded = expandedEmailId === msg.gmail_message_id;
                                      return (
                                        <div key={msg.gmail_message_id}>
                                          <button
                                            type="button"
                                            className="w-full text-left p-2 rounded-lg hover:bg-surface-container-low transition-colors cursor-pointer"
                                            onClick={() => handleExpandEmail(msg.gmail_message_id)}
                                          >
                                            <div className="flex items-start gap-2">
                                              {msg.direction === "outbound" ? (
                                                <ArrowUpRight className="h-3 w-3 shrink-0 text-primary mt-0.5" />
                                              ) : (
                                                <ArrowDownLeft className="h-3 w-3 shrink-0 text-tertiary mt-0.5" />
                                              )}
                                              <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                  <span className="text-xs font-medium text-foreground truncate">
                                                    {msg.direction === "outbound" ? "You" : (contactName || msg.from_address || "Unknown")}
                                                  </span>
                                                  <span className="text-[11px] text-muted-foreground shrink-0">
                                                    {msg.date ? formatDateFull(msg.date) : ""}
                                                  </span>
                                                </div>
                                                <p className="text-xs text-muted-foreground truncate mt-0.5">{msg.snippet || ""}</p>
                                              </div>
                                            </div>
                                          </button>

                                          {/* Expanded email content */}
                                          {isMsgExpanded && (
                                            <div className="ml-5 mr-1 mb-1 p-3 rounded-lg bg-surface-container-low border border-outline-variant/50">
                                              {loadingEmailContent ? (
                                                <div className="flex items-center gap-2 text-muted-foreground text-xs py-4">
                                                  <div className="animate-spin rounded-full h-3 w-3 border border-primary border-t-transparent" />
                                                  Loading email…
                                                </div>
                                              ) : expandedEmailContent ? (
                                                <div>
                                                  <div className="text-xs text-muted-foreground space-y-0.5 mb-3">
                                                    <p><span className="font-medium">From:</span> {expandedEmailContent.from}</p>
                                                    <p><span className="font-medium">To:</span> {expandedEmailContent.to}</p>
                                                    <p><span className="font-medium">Date:</span> {expandedEmailContent.date ? new Date(expandedEmailContent.date).toLocaleString() : ""}</p>
                                                  </div>
                                                  {expandedEmailContent.bodyHtml ? (
                                                    <div
                                                      className="text-sm prose prose-sm max-w-none [&_*]:!text-foreground [&_a]:!text-primary overflow-auto max-h-80"
                                                      dangerouslySetInnerHTML={{ __html: expandedEmailContent.bodyHtml }}
                                                    />
                                                  ) : (
                                                    <pre className="text-sm text-foreground whitespace-pre-wrap overflow-auto max-h-80">
                                                      {expandedEmailContent.bodyText || "No content available"}
                                                    </pre>
                                                  )}

                                                  <div className="mt-3 pt-3 border-t border-outline-variant/50 flex items-center gap-4">
                                                    <button
                                                      type="button"
                                                      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors"
                                                      onClick={() => {
                                                        const replyTo = msg.direction === "outbound"
                                                          ? (msg.to_addresses?.[0] || "")
                                                          : (msg.from_address || "");
                                                        const subj = expandedEmailContent.subject || "";
                                                        const reSubj = subj.replace(/^(Re:\s*)+/i, "");
                                                        openCompose({
                                                          to: replyTo,
                                                          name: contactName || undefined,
                                                          subject: `Re: ${reSubj}`,
                                                          threadId: expandedEmailContent.threadId,
                                                          inReplyTo: expandedEmailContent.messageId,
                                                          references: expandedEmailContent.messageId,
                                                          quotedHtml: expandedEmailContent.bodyHtml || expandedEmailContent.bodyText || "",
                                                        });
                                                      }}
                                                    >
                                                      <Reply className="h-3.5 w-3.5" />
                                                      Reply
                                                    </button>
                                                    {msg.direction === "outbound" && msg.date && (Date.now() - new Date(msg.date).getTime()) < 14 * 86400_000 && (
                                                      <button
                                                        type="button"
                                                        className="inline-flex items-center gap-1.5 text-xs font-medium text-tertiary hover:text-tertiary/80 cursor-pointer transition-colors"
                                                        onClick={() => {
                                                          setFollowUpModal({
                                                            recipientEmail: msg.to_addresses?.[0] || "",
                                                            contactName: contactName || null,
                                                            originalSubject: expandedEmailContent.subject || thread.subject,
                                                            originalSentAt: msg.date!,
                                                            originalGmailMessageId: msg.gmail_message_id,
                                                            threadId: thread.threadId,
                                                          });
                                                        }}
                                                      >
                                                        <Clock className="h-3.5 w-3.5" />
                                                        Schedule follow-up
                                                      </button>
                                                    )}
                                                    {contactName && thread.contactId && (
                                                      <button
                                                        type="button"
                                                        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                                                        onClick={() => router.push(`/contacts/${thread.contactId}`)}
                                                      >
                                                        View contact
                                                      </button>
                                                    )}
                                                  </div>
                                                </div>
                                              ) : (
                                                <p className="text-xs text-muted-foreground">Failed to load email content.</p>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}

                                    {/* Quick reply at thread bottom */}
                                    <div className="pl-2 pt-1 pb-1 flex items-center gap-4">
                                      <button
                                        type="button"
                                        className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors"
                                        onClick={() => {
                                          const lastMsg = thread.messages[thread.messages.length - 1];
                                          const replyTo = lastMsg.direction === "outbound"
                                            ? (lastMsg.to_addresses?.[0] || "")
                                            : (lastMsg.from_address || "");
                                          const subj = thread.subject.replace(/^(Re:\s*)+/i, "");
                                          openCompose({
                                            to: replyTo,
                                            name: contactName || undefined,
                                            subject: `Re: ${subj}`,
                                            threadId: thread.threadId,
                                          });
                                        }}
                                      >
                                        <Reply className="h-3.5 w-3.5" />
                                        Reply
                                      </button>
                                      {thread.contactId && (
                                        <button
                                          type="button"
                                          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                                          onClick={() => router.push(`/contacts/${thread.contactId}`)}
                                        >
                                          View contact
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* ─── SCHEDULED TAB ─── */}
                {activeTab === "scheduled" && (
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-sm font-medium text-foreground">
                        Scheduled emails
                        {scheduledEmails.length > 0 && (
                          <span className="ml-1.5 text-muted-foreground font-normal">({scheduledEmails.length})</span>
                        )}
                      </h2>
                    </div>

                    {scheduledEmails.length === 0 ? (
                      <div className="text-center py-16">
                        <Send className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">No scheduled emails.</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Use the "Schedule" option in Compose to queue emails for later.
                        </p>
                      </div>
                    ) : (
                      <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
                        {scheduledEmails.map((se) => {
                          const contactName = se.matched_contact_id ? contactMap[se.matched_contact_id] : null;
                          const linkedFU = followUps.find((fu) => fu.scheduled_email_id === se.id);

                          return (
                            <div key={se.id} className="px-4 py-3 hover:bg-surface-container-low/50 transition-colors">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-tertiary-container flex items-center justify-center shrink-0">
                                  <Clock className="h-3.5 w-3.5 text-on-tertiary-container" />
                                </div>

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-foreground truncate">{se.subject}</span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-tertiary-container/50 text-on-tertiary-container shrink-0">
                                      Scheduled
                                    </span>
                                    {linkedFU && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-tertiary-container/30 text-on-tertiary-container shrink-0">
                                        + {linkedFU.email_follow_up_messages.filter((m) => m.status === "pending").length} follow-up(s)
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-xs text-muted-foreground truncate">
                                      To: {contactName || se.recipient_email}
                                    </span>
                                    <span className="text-xs text-muted-foreground">·</span>
                                    <span className="text-xs text-muted-foreground shrink-0">
                                      Sends {formatDateFull(se.scheduled_send_at)}
                                    </span>
                                  </div>
                                </div>

                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setFollowUpModal({
                                        recipientEmail: se.recipient_email,
                                        contactName: se.contact_name,
                                        originalSubject: se.subject,
                                        originalSentAt: se.scheduled_send_at,
                                        originalGmailMessageId: `scheduled_${se.id}`,
                                        threadId: se.thread_id || `pending_scheduled_${se.id}`,
                                        scheduledEmailId: se.id,
                                        existingFollowUp: linkedFU || null,
                                      });
                                    }}
                                    className="p-1.5 rounded-full text-muted-foreground hover:text-tertiary cursor-pointer transition-colors"
                                    title="Schedule follow-up"
                                  >
                                    <Clock className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => cancelScheduledEmail(se.id)}
                                    className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                                    title="Cancel scheduled email"
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* ─── FOLLOW-UPS TAB ─── */}
                {activeTab === "followups" && (
                  <div>
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-sm font-medium text-foreground">
                        Active follow-ups
                        {followUps.length > 0 && (
                          <span className="ml-1.5 text-muted-foreground font-normal">({followUps.length} sequence{followUps.length !== 1 ? "s" : ""})</span>
                        )}
                      </h2>
                    </div>

                    {followUps.length === 0 ? (
                      <div className="text-center py-16">
                        <Clock className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">No active follow-ups.</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Schedule follow-ups from sent emails to automate reminders.
                        </p>
                      </div>
                    ) : (
                      <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
                        {followUps.map((fu) => {
                          const pendingMsgs = fu.email_follow_up_messages
                            .filter((m) => m.status === "pending")
                            .sort((a, b) => a.sequence_number - b.sequence_number);
                          const nextMsg = pendingMsgs[0];

                          return (
                            <div key={fu.id} className="px-4 py-3 hover:bg-surface-container-low/50 transition-colors">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-tertiary-container/50 flex items-center justify-center shrink-0">
                                  <Clock className="h-3.5 w-3.5 text-on-tertiary-container" />
                                </div>

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-foreground truncate">
                                      {fu.original_subject || "(no subject)"}
                                    </span>
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-tertiary-container/50 text-on-tertiary-container shrink-0">
                                      {pendingMsgs.length} pending
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-xs text-muted-foreground truncate">
                                      To: {fu.contact_name || fu.recipient_email}
                                    </span>
                                    {nextMsg && (
                                      <>
                                        <span className="text-xs text-muted-foreground">·</span>
                                        <span className="text-xs text-muted-foreground shrink-0">
                                          Next: {formatDateFull(nextMsg.scheduled_send_at)}
                                        </span>
                                      </>
                                    )}
                                  </div>

                                  {/* All messages in the sequence */}
                                  <div className="flex flex-wrap gap-1.5 mt-2">
                                    {fu.email_follow_up_messages
                                      .sort((a, b) => a.sequence_number - b.sequence_number)
                                      .map((m) => (
                                        <span
                                          key={m.id}
                                          className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                                            m.status === "sent"
                                              ? "bg-primary/15 text-primary"
                                              : m.status === "cancelled"
                                              ? "bg-surface-container-low text-muted-foreground line-through"
                                              : "bg-tertiary-container/50 text-on-tertiary-container"
                                          }`}
                                        >
                                          #{m.sequence_number}: Day {m.send_after_days}
                                          {m.status === "sent" && " (sent)"}
                                          {m.status === "cancelled" && " (cancelled)"}
                                          {m.status === "pending" &&
                                            ` (${new Date(m.scheduled_send_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`}
                                        </span>
                                      ))}
                                  </div>
                                  <p className="text-[10px] text-muted-foreground mt-1">Auto-cancels if they reply</p>
                                </div>

                                <div className="flex flex-col gap-1 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setFollowUpModal({
                                        recipientEmail: fu.recipient_email,
                                        contactName: fu.contact_name,
                                        originalSubject: fu.original_subject || "",
                                        originalSentAt: fu.original_sent_at,
                                        originalGmailMessageId: fu.original_gmail_message_id,
                                        threadId: fu.thread_id,
                                        existingFollowUp: fu,
                                      });
                                    }}
                                    className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors"
                                    title="Edit follow-ups"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => cancelFollowUp(fu.id)}
                                    className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                                    title="Cancel all follow-ups"
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Follow-up modal */}
      <FollowUpModal
        isOpen={!!followUpModal}
        onClose={() => {
          setFollowUpModal(null);
          loadInbox();
        }}
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
