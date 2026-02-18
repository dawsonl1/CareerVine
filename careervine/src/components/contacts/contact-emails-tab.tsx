"use client";

import { useState, useMemo, useEffect } from "react";
import { useCompose } from "@/components/compose-email-context";
import { FollowUpModal } from "@/components/follow-up-modal";
import type { EmailMessage, EmailMessageFull, EmailFollowUp, ScheduledEmail } from "@/lib/types";
import { Inbox, ArrowUpRight, ArrowDownLeft, Reply, Clock, XCircle, Pencil, Check } from "lucide-react";

type EmailThread = {
  threadId: string;
  subject: string;
  messages: EmailMessage[];
  latestDate: string;
  latestDirection: string | null;
};

interface ContactEmailsTabProps {
  contactId: number;
  contactName: string;
  contactEmails: string[];
  emails: EmailMessage[];
  scheduledEmails: ScheduledEmail[];
  gmailConnected: boolean;
  onScheduledEmailCancel: (id: number) => void;
  onReloadEmails: () => void;
}

export function ContactEmailsTab({
  contactId,
  contactName,
  contactEmails: contactEmailAddresses,
  emails,
  scheduledEmails,
  gmailConnected,
  onScheduledEmailCancel,
  onReloadEmails,
}: ContactEmailsTabProps) {
  const { openCompose } = useCompose();

  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [expandedEmailId, setExpandedEmailId] = useState<string | null>(null);
  const [expandedEmailContent, setExpandedEmailContent] = useState<EmailMessageFull | null>(null);
  const [loadingEmailContent, setLoadingEmailContent] = useState(false);
  const [loadingEmails] = useState(false);

  const [threadFollowUps, setThreadFollowUps] = useState<Record<string, EmailFollowUp[]>>({});
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

  // Load all follow-ups upfront so badges appear on thread headers
  useEffect(() => {
    if (!gmailConnected) return;
    fetch("/api/gmail/follow-ups")
      .then((res) => res.json())
      .then((data) => {
        if (data.followUps) {
          const grouped: Record<string, EmailFollowUp[]> = {};
          for (const fu of data.followUps) {
            if (!grouped[fu.thread_id]) grouped[fu.thread_id] = [];
            grouped[fu.thread_id].push(fu);
          }
          setThreadFollowUps(grouped);
        }
      })
      .catch(() => {});
  }, [gmailConnected, emails]);

  const emailThreads = useMemo<EmailThread[]>(() => {
    if (emails.length === 0) return [];
    const map = new Map<string, EmailMessage[]>();
    for (const email of emails) {
      const tid = email.thread_id || email.gmail_message_id;
      if (!map.has(tid)) map.set(tid, []);
      map.get(tid)!.push(email);
    }
    const threads: EmailThread[] = [];
    for (const [threadId, msgs] of map) {
      msgs.sort((a, b) => new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime());
      const latest = msgs[msgs.length - 1];
      threads.push({
        threadId,
        subject: msgs[0].subject || "(no subject)",
        messages: msgs,
        latestDate: latest.date || "",
        latestDirection: latest.direction,
      });
    }
    threads.sort((a, b) => new Date(b.latestDate).getTime() - new Date(a.latestDate).getTime());
    return threads;
  }, [emails]);

  const handleExpandEmail = async (gmailMessageId: string) => {
    if (expandedEmailId === gmailMessageId) {
      setExpandedEmailId(null);
      setExpandedEmailContent(null);
      return;
    }
    setExpandedEmailId(gmailMessageId);
    setExpandedEmailContent(null);
    setLoadingEmailContent(true);

    // Mark as read in Gmail + local DB
    const msg = emails.find((e) => e.gmail_message_id === gmailMessageId);
    if (msg && !msg.is_read) {
      fetch(`/api/gmail/emails/${gmailMessageId}/read`, { method: "POST" }).catch(() => {});
      window.dispatchEvent(new CustomEvent("careervine:unread-changed"));
    }

    try {
      const res = await fetch(`/api/gmail/emails/${gmailMessageId}`);
      const data = await res.json();
      if (data.success) {
        setExpandedEmailContent(data.message);
      }
    } catch (err) {
      console.error("Error loading email content:", err);
    } finally {
      setLoadingEmailContent(false);
    }
  };

  const loadFollowUpsForThread = async (threadId: string) => {
    try {
      const res = await fetch(`/api/gmail/follow-ups?threadId=${threadId}`);
      const data = await res.json();
      if (data.followUps) {
        setThreadFollowUps((prev) => ({ ...prev, [threadId]: data.followUps }));
      }
    } catch {}
  };

  const cancelFollowUp = async (followUpId: number, threadId: string) => {
    try {
      const res = await fetch(`/api/gmail/follow-ups/${followUpId}`, { method: "DELETE" });
      if (res.ok) loadFollowUpsForThread(threadId);
    } catch (err) {
      console.error("Error cancelling follow-up:", err);
    }
  };

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-3">
        <Inbox className="h-3.5 w-3.5" /> Emails{emailThreads.length > 0 ? ` (${emailThreads.length} thread${emailThreads.length !== 1 ? "s" : ""})` : ""}
      </h4>

      {/* Scheduled (queued) emails */}
      {scheduledEmails.length > 0 && (
        <div className="space-y-1 mb-3">
          {scheduledEmails.map((se) => (
            <div key={se.id} className="flex items-start gap-2 p-2 rounded-lg bg-tertiary-container/15 border border-tertiary/15">
              <Clock className="h-3.5 w-3.5 text-tertiary shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground truncate">{se.subject}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-tertiary-container/50 text-on-tertiary-container shrink-0">
                    Scheduled
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  To: {se.recipient_email} · Sends {new Date(se.scheduled_send_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {gmailConnected && (
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
                      });
                    }}
                    className="p-1 rounded-full text-muted-foreground hover:text-tertiary cursor-pointer transition-colors"
                    title="Schedule follow-up"
                  >
                    <Clock className="h-3 w-3" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onScheduledEmailCancel(se.id)}
                  className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                  title="Cancel scheduled email"
                >
                  <XCircle className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {loadingEmails ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs py-2">
          <div className="animate-spin rounded-full h-3 w-3 border border-primary border-t-transparent" />
          Loading emails…
        </div>
      ) : emailThreads.length === 0 && scheduledEmails.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {contactEmailAddresses.length === 0
            ? "No email addresses on file for this contact."
            : "No email history found."}
        </p>
      ) : (
        <div className="space-y-1">
          {emailThreads.slice(0, 15).map((thread) => {
            const isThreadExpanded = expandedThreadId === thread.threadId;
            const latest = thread.messages[thread.messages.length - 1];
            return (
              <div key={thread.threadId}>
                {/* Thread header */}
                <button
                  type="button"
                  className="w-full text-left p-2 rounded-lg hover:bg-surface-container-low transition-colors cursor-pointer group"
                  onClick={() => {
                    const newThreadId = isThreadExpanded ? null : thread.threadId;
                    setExpandedThreadId(newThreadId);
                    setExpandedEmailId(null);
                    setExpandedEmailContent(null);
                    if (newThreadId && gmailConnected) {
                      loadFollowUpsForThread(newThreadId);
                    }
                  }}
                >
                  <div className="flex items-start gap-2">
                    {latest.direction === "outbound" ? (
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-primary mt-0.5" />
                    ) : (
                      <ArrowDownLeft className="h-3.5 w-3.5 shrink-0 text-tertiary mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm truncate text-foreground">{thread.subject}</span>
                        {thread.messages.length > 1 && (
                          <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-secondary-container text-[10px] font-medium text-on-secondary-container shrink-0">
                            {thread.messages.length}
                          </span>
                        )}
                        {(() => {
                          const activeFollowUps = (threadFollowUps[thread.threadId] || []).filter((fu) => fu.status === "active");
                          const pendingCount = activeFollowUps.reduce((sum, fu) => sum + fu.email_follow_up_messages.filter((m) => m.status === "pending").length, 0);
                          if (pendingCount === 0) return null;
                          return (
                            <span className="inline-flex items-center gap-1 h-4 px-1.5 rounded-full bg-tertiary-container/50 text-[10px] font-medium text-on-tertiary-container shrink-0">
                              <Clock className="h-2.5 w-2.5" />
                              {pendingCount}
                            </span>
                          );
                        })()}
                        <span className="text-[11px] text-muted-foreground shrink-0">
                          {thread.latestDate ? new Date(thread.latestDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{latest.snippet || ""}</p>
                    </div>
                  </div>
                </button>

                {/* Expanded thread — all messages */}
                {isThreadExpanded && (
                  <div className="ml-4 mr-2 mb-2 border-l-2 border-outline-variant/50 pl-3 space-y-0.5">
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
                                    {msg.direction === "outbound" ? "You" : (msg.from_address || "Unknown")}
                                  </span>
                                  <span className="text-[11px] text-muted-foreground shrink-0">
                                    {msg.date ? new Date(msg.date).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                                  </span>
                                </div>
                                <p className="text-xs text-muted-foreground truncate mt-0.5">{msg.snippet || ""}</p>
                              </div>
                            </div>
                          </button>

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
                                  {gmailConnected && (
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
                                            name: contactName,
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
                                              contactName,
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
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-xs text-muted-foreground">Failed to load email content.</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Reply + Follow-up at thread bottom */}
                    {gmailConnected && (
                      <div className="pl-2 pt-1 pb-1 space-y-2">
                        <div className="flex items-center gap-4">
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
                                name: contactName,
                                subject: `Re: ${subj}`,
                                threadId: thread.threadId,
                              });
                            }}
                          >
                            <Reply className="h-3.5 w-3.5" />
                            Reply to thread
                          </button>
                          {(() => {
                            const outbound = thread.messages.find(
                              (m) => m.direction === "outbound" && m.date && (Date.now() - new Date(m.date).getTime()) < 14 * 86400_000
                            );
                            if (!outbound) return null;
                            return (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-tertiary hover:text-tertiary/80 cursor-pointer transition-colors"
                                onClick={() => {
                                  setFollowUpModal({
                                    recipientEmail: outbound.to_addresses?.[0] || "",
                                    contactName,
                                    originalSubject: thread.subject,
                                    originalSentAt: outbound.date!,
                                    originalGmailMessageId: outbound.gmail_message_id,
                                    threadId: thread.threadId,
                                  });
                                }}
                              >
                                <Clock className="h-3.5 w-3.5" />
                                Schedule follow-up
                              </button>
                            );
                          })()}
                        </div>

                        {/* Active follow-ups indicator */}
                        {(threadFollowUps[thread.threadId] || [])
                          .filter((fu) => fu.status === "active")
                          .map((fu) => (
                            <div key={fu.id} className="flex items-start gap-2 p-2 rounded-lg bg-tertiary-container/20 border border-tertiary/15">
                              <Clock className="h-3.5 w-3.5 text-tertiary shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-medium text-foreground">
                                  {fu.email_follow_up_messages.filter((m) => m.status === "pending").length} follow-up
                                  {fu.email_follow_up_messages.filter((m) => m.status === "pending").length !== 1 ? "s" : ""} scheduled
                                </p>
                                <div className="flex flex-wrap gap-1.5 mt-1">
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
                                        {m.status === "pending" && ` (${new Date(m.scheduled_send_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`}
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
                                      originalSubject: fu.original_subject || thread.subject,
                                      originalSentAt: fu.original_sent_at,
                                      originalGmailMessageId: fu.original_gmail_message_id,
                                      threadId: fu.thread_id,
                                      existingFollowUp: fu,
                                    });
                                  }}
                                  className="p-1 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors"
                                  title="Edit follow-ups"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => cancelFollowUp(fu.id, thread.threadId)}
                                  className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                                  title="Cancel all follow-ups"
                                >
                                  <XCircle className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}

                        {/* Completed/cancelled follow-ups */}
                        {(threadFollowUps[thread.threadId] || []).filter((fu) => fu.status !== "active").length > 0 && (
                          <p className="text-[10px] text-muted-foreground">
                            {(threadFollowUps[thread.threadId] || []).filter((fu) => fu.status === "cancelled_reply").length > 0 && (
                              <span className="inline-flex items-center gap-1 mr-2">
                                <Check className="h-2.5 w-2.5" /> Follow-ups cancelled (reply received)
                              </span>
                            )}
                            {(threadFollowUps[thread.threadId] || []).filter((fu) => fu.status === "completed").length > 0 && (
                              <span className="inline-flex items-center gap-1 mr-2">
                                <Check className="h-2.5 w-2.5" /> Follow-ups completed
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {emailThreads.length > 15 && (
            <p className="text-xs text-muted-foreground pl-6 pt-1">
              Showing 15 of {emailThreads.length} threads
            </p>
          )}
        </div>
      )}

      {/* Follow-up scheduling modal */}
      <FollowUpModal
        isOpen={!!followUpModal}
        onClose={() => {
          if (followUpModal) loadFollowUpsForThread(followUpModal.threadId);
          setFollowUpModal(null);
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
