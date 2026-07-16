"use client";

/**
 * Free-tier "Outreach" portal (CAR-102).
 *
 * The destination for free users (capability `outreach:portal`), selected by
 * EmailExperience. Built entirely on the DB-only /api/gmail/inbox payload: the
 * outreach a user has sent, what is scheduled, their follow-up plans, and drafts.
 * No live mailbox read (free users hold only the gmail.send scope), so there is no inbox,
 * labels, sync, or trash/label actions here. Every tab can expand to show the full
 * body from the DB payload (CAR-115 sent, CAR-127 drafts, CAR-128 scheduled +
 * follow-up steps) — not a live fetch. Composing and sending work (send needs only
 * gmail.send), via the shared compose modal.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { FollowUpModal } from "@/components/follow-up-modal";
import { buildThreads } from "@/lib/gmail-helpers";
import {
  isActionableFollowUpMessage,
  isUnresolvedFollowUpMessage,
  FollowUpMessageStatus,
} from "@/lib/constants";
import type { EmailMessage, EmailFollowUp, EmailFollowUpMessage, ScheduledEmail, EmailDraft, ContactEmployment } from "@/lib/types";
import { Send, Clock, Reply, PenSquare, Pencil, Loader2, Inbox as InboxIcon, ArrowUpRight, Check, ChevronDown, ChevronRight, FileText, X, RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import DOMPurify from "dompurify";
import { useCapabilities } from "@/hooks/use-capabilities";
import { PremiumUpgradeBanner } from "@/components/email/premium-upgrade-banner";

type OutreachTab = "sent" | "scheduled" | "followups" | "drafts";
type ContactDetailsMap = Record<number, ContactEmployment>;

/** Short "Jul 12" / "Jul 12, 2025" date, safe for a client-only render. */
function fmtDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

/** Short date + time, for scheduled sends. */
function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${fmtDate(value)}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** Whole days from now until `value` (negative once past). null if unparseable. */
function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - Date.now()) / (24 * 60 * 60 * 1000));
}

/** Status chip for an open follow-up step on Outreach (CAR-125). */
function openStepChip(status: string): { label: string; className: string } {
  if (status === FollowUpMessageStatus.AwaitingReview) {
    return { label: "Needs confirm", className: "bg-primary/15 text-primary" };
  }
  if (status === FollowUpMessageStatus.Expired) {
    return { label: "Expired", className: "bg-surface-container-high text-muted-foreground" };
  }
  return { label: "Scheduled", className: "bg-secondary text-secondary-foreground" };
}

/** Sequence progress: every unresolved step (pending + awaiting_review + expired),
 * the messages the user can still act on, how many were actually sent, and the
 * total. Expired is deliberately NOT counted as sent (CAR-105). */
function followUpProgress(fu: EmailFollowUp): {
  openSteps: EmailFollowUpMessage[];
  actionable: EmailFollowUpMessage[];
  sentCount: number;
  total: number;
} {
  const msgs = fu.email_follow_up_messages ?? [];
  const openSteps = msgs
    .filter((m) => isUnresolvedFollowUpMessage(m.status))
    .sort((a, b) => (a.sequence_number ?? 0) - (b.sequence_number ?? 0));
  const actionable = openSteps.filter((m) => isActionableFollowUpMessage(m.status));
  const sentCount = msgs.filter((m) => m.status === FollowUpMessageStatus.Sent).length;
  return { openSteps, actionable, sentCount, total: msgs.length };
}

export function OutreachShell() {
  const { user } = useAuth();
  const { gmailConnected, gmailLoading, openCompose } = useCompose();
  const { can } = useCapabilities();
  const showInboxUpgrade = can("inbox:upgrade");
  const { success: toastSuccess, error: toastError } = useToast();

  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState<OutreachTab>("sent");
  const [followUpModal, setFollowUpModal] = useState<EmailFollowUp | null>(null);

  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [followUps, setFollowUps] = useState<EmailFollowUp[]>([]);
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [contactMap, setContactMap] = useState<Record<number, string>>({});
  const [contactDetails, setContactDetails] = useState<ContactDetailsMap>({});
  const [cancellingDraftId, setCancellingDraftId] = useState<number | null>(null);
  const [retryingScheduledId, setRetryingScheduledId] = useState<number | null>(null);

  const loadDrafts = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail/drafts");
      const data = await res.json();
      setDrafts(data.drafts || []);
      if (data.contactDetails) {
        setContactDetails((prev) => ({ ...prev, ...data.contactDetails }));
      }
    } catch {
      // best-effort — drafts are additive to the main inbox payload
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/gmail/inbox");
      const data = await res.json();
      if (data.success) {
        setEmails(data.emails || []);
        setScheduledEmails(data.scheduledEmails || []);
        setFollowUps(data.followUps || []);
        setContactMap(data.contactMap || {});
        setContactDetails((prev) => ({ ...prev, ...(data.contactDetails || {}) }));
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      void load();
      void loadDrafts();
    }
  }, [user, load, loadDrafts]);

  useEffect(() => {
    const handler = () => void loadDrafts();
    window.addEventListener("careervine:drafts-changed", handler);
    return () => window.removeEventListener("careervine:drafts-changed", handler);
  }, [loadDrafts]);

  // Confirm-to-send: the user either sends a parked follow-up now (replied=false)
  // or reports that the contact already replied (replied=true, which cancels + activates).
  const confirmFollowUp = useCallback(
    async (messageId: number, replied: boolean) => {
      if (confirmingId) return;
      setConfirmingId(messageId);
      try {
        const res = await fetch("/api/gmail/follow-ups/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId, replied }),
        });
        if (!res.ok) throw new Error();
        toastSuccess(replied ? "Marked as replied" : "Follow-up sent");
        await load();
        // The confirm changed how many follow-ups await review — refresh the nav badge.
        window.dispatchEvent(new CustomEvent("careervine:unread-changed", { detail: { refetch: true } }));
      } catch {
        toastError(replied ? "Could not update this follow-up" : "Could not send the follow-up");
      } finally {
        setConfirmingId(null);
      }
    },
    [confirmingId, load, toastSuccess, toastError],
  );

  // A failed scheduled email (the send process died mid-flight, CAR-134) can
  // be requeued; the user decides, since the original may or may not have
  // actually gone out.
  const retryScheduledEmail = useCallback(
    async (id: number) => {
      if (retryingScheduledId) return;
      setRetryingScheduledId(id);
      try {
        const res = await fetch(`/api/gmail/schedule/${id}/retry`, { method: "POST" });
        if (!res.ok) throw new Error();
        // Kick the send driver so it goes out now, not on the next cron tick.
        fetch("/api/gmail/schedule/process", { method: "POST" }).catch(() => {});
        toastSuccess("Email queued to send now");
        await load();
      } catch {
        toastError("Could not retry this email");
      } finally {
        setRetryingScheduledId(null);
      }
    },
    [retryingScheduledId, load, toastSuccess, toastError],
  );

  // Sent outreach = the user's outbound messages, grouped into threads.
  const sentThreads = useMemo(
    () => buildThreads(emails.filter((e) => e.direction === "outbound")),
    [emails],
  );

  const openDraft = useCallback(
    (draft: EmailDraft) => {
      const detail =
        draft.matched_contact_id != null ? contactDetails[draft.matched_contact_id] : null;
      openCompose({
        to: draft.recipient_email || undefined,
        name: detail?.name || draft.contact_name || undefined,
        subject: draft.subject || undefined,
        bodyHtml: draft.body_html || undefined,
        threadId: draft.thread_id || undefined,
        inReplyTo: draft.in_reply_to || undefined,
        references: draft.references_header || undefined,
        draftId: draft.id,
        contactId: draft.matched_contact_id || undefined,
      });
    },
    [openCompose, contactDetails],
  );

  const cancelDraft = useCallback(
    async (draftId: number) => {
      if (cancellingDraftId) return;
      setCancellingDraftId(draftId);
      const previous = drafts;
      setDrafts((prev) => prev.filter((d) => d.id !== draftId));
      try {
        const res = await fetch(`/api/gmail/drafts/${draftId}`, { method: "DELETE" });
        if (!res.ok) throw new Error();
        toastSuccess("Draft cancelled");
      } catch {
        setDrafts(previous);
        toastError("Could not cancel this draft");
      } finally {
        setCancellingDraftId(null);
      }
    },
    [cancellingDraftId, drafts, toastSuccess, toastError],
  );

  const tabs: { key: OutreachTab; label: string; count: number }[] = [
    { key: "sent", label: "Sent", count: sentThreads.length },
    { key: "drafts", label: "Drafts", count: drafts.length },
    { key: "scheduled", label: "Scheduled", count: scheduledEmails.length },
    { key: "followups", label: "Follow-ups", count: followUps.length },
  ];

  const showConnectPrompt = !gmailLoading && !gmailConnected;

  return (
    <>
      <Navigation />
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-on-surface">Outreach</h1>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Everything you have sent, drafts in progress, what is scheduled next, and your follow-up plans, all in one place.
            </p>
          </div>
          <Button onClick={() => openCompose()} size="md">
            <PenSquare className="h-4 w-4" />
            Compose
          </Button>
        </header>

        {showInboxUpgrade && !showConnectPrompt && (
          <div className="mb-5">
            <PremiumUpgradeBanner source="outreach" />
          </div>
        )}

        {gmailLoading || loading ? (
          <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-label="Loading">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : showConnectPrompt ? (
          <ConnectPrompt />
        ) : error ? (
          <ErrorState onRetry={() => void load()} />
        ) : (
          <>
            <nav className="mb-5 flex gap-1 border-b border-outline-variant" aria-label="Outreach views">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  aria-current={activeTab === t.key ? "page" : undefined}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                    activeTab === t.key
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-on-surface"
                  }`}
                >
                  {t.label}
                  <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>
                </button>
              ))}
            </nav>

            {activeTab === "sent" && (
              <SentList threads={sentThreads} contactDetails={contactDetails} contactMap={contactMap} />
            )}
            {activeTab === "drafts" && (
              <DraftsList
                items={drafts}
                contactDetails={contactDetails}
                onEdit={openDraft}
                onCancel={cancelDraft}
                cancellingId={cancellingDraftId}
              />
            )}
            {activeTab === "scheduled" && (
              <ScheduledList
                items={scheduledEmails}
                contactDetails={contactDetails}
                contactMap={contactMap}
                onRetry={retryScheduledEmail}
                retryingId={retryingScheduledId}
              />
            )}
            {activeTab === "followups" && (
              <FollowUpList
                items={followUps}
                contactDetails={contactDetails}
                onConfirm={confirmFollowUp}
                confirmingId={confirmingId}
                onEdit={setFollowUpModal}
              />
            )}
          </>
        )}
      </main>

      <FollowUpModal
        isOpen={!!followUpModal}
        onClose={() => {
          setFollowUpModal(null);
          void load();
        }}
        recipientEmail={followUpModal?.recipient_email || ""}
        contactName={followUpModal?.contact_name || null}
        originalSubject={followUpModal?.original_subject || ""}
        originalSentAt={followUpModal?.original_sent_at || new Date().toISOString()}
        originalGmailMessageId={followUpModal?.original_gmail_message_id || ""}
        threadId={followUpModal?.thread_id || ""}
        existingFollowUp={followUpModal}
      />
    </>
  );
}

// ── Sub-views ──────────────────────────────────────────────────────────────

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-outline-variant px-6 py-16 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-sm font-medium text-on-surface">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="rounded-xl border border-outline-variant bg-surface px-4 py-3 transition-colors hover:bg-surface-container-low">
      {children}
    </li>
  );
}

/** Full HTML body for an expanded Outreach email. No max-height clip (CAR-128):
 * the page scrolls so the entire message is readable. */
function EmailBodyHtml({
  html,
  emptyHint = "No body.",
}: {
  html: string | null | undefined;
  emptyHint?: string;
}) {
  if (html) {
    return (
      <div
        className="prose prose-sm max-w-none [&_*]:!text-on-surface [&_a]:!text-primary [&_a]:underline"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }}
      />
    );
  }
  return <p className="text-sm italic text-muted-foreground">{emptyHint}</p>;
}

/**
 * Recipient line for an Outreach email row (CAR-127).
 * Contact and company are links when we have ids; role + office are plain text.
 */
function RecipientMeta({
  contactId,
  fallbackName,
  contactDetails,
  contactMap,
  suffix,
}: {
  contactId: number | null | undefined;
  fallbackName: string | null | undefined;
  contactDetails: ContactDetailsMap;
  contactMap?: Record<number, string>;
  suffix?: string;
}) {
  const detail = contactId != null ? contactDetails[contactId] : undefined;
  const name =
    detail?.name ||
    (contactId != null && contactMap?.[contactId]) ||
    fallbackName ||
    "Unknown recipient";

  const bits: React.ReactNode[] = [];

  if (contactId != null) {
    bits.push(
      <Link
        key="contact"
        href={`/contacts/${contactId}`}
        className="font-medium text-on-surface hover:text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {name}
      </Link>,
    );
  } else {
    bits.push(
      <span key="contact" className="font-medium text-on-surface">
        {name}
      </span>,
    );
  }

  if (detail?.title) {
    bits.push(
      <span key="title" className="text-muted-foreground">
        {detail.title}
      </span>,
    );
  }

  if (detail?.company_name) {
    if (detail.company_id != null) {
      bits.push(
        <Link
          key="company"
          href={`/companies/${detail.company_id}`}
          className="text-muted-foreground hover:text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {detail.company_name}
        </Link>,
      );
    } else {
      bits.push(
        <span key="company" className="text-muted-foreground">
          {detail.company_name}
        </span>,
      );
    }
  }

  if (detail?.location_label) {
    bits.push(
      <span key="loc" className="text-muted-foreground">
        {detail.location_label}
      </span>,
    );
  }

  return (
    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <span>To</span>
      {bits.flatMap((bit, i) =>
        i === 0
          ? [bit]
          : [
              <span key={`sep-${i}`} className="text-muted-foreground/60" aria-hidden>
                ·
              </span>,
              bit,
            ],
      )}
      {suffix ? (
        <>
          <span className="text-muted-foreground/60" aria-hidden>
            ·
          </span>
          <span>{suffix.replace(/^·\s*/, "")}</span>
        </>
      ) : null}
    </span>
  );
}

function SentList({
  threads,
  contactDetails,
  contactMap,
}: {
  threads: ReturnType<typeof buildThreads>;
  contactDetails: ContactDetailsMap;
  contactMap: Record<number, string>;
}) {
  const { openCompose } = useCompose();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (threads.length === 0) {
    return (
      <EmptyState
        icon={<Send className="h-6 w-6" />}
        title="No sent outreach yet"
        hint="Compose your first email and it will show up here with its follow-up status."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {threads.map((t) => {
        const last = t.messages[t.messages.length - 1];
        const to = last?.to_addresses?.[0] ?? null;
        const isExpanded = expandedId === t.threadId;
        return (
          <Row key={t.threadId}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : t.threadId)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse email" : "Expand to read what was sent"}
                  className="flex w-full min-w-0 items-start gap-2 text-left"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                  <span className="block min-w-0 truncate text-sm font-medium text-on-surface">{t.subject}</span>
                </button>
                <div className="pl-6">
                  <RecipientMeta
                    contactId={t.contactId}
                    fallbackName={to}
                    contactDetails={contactDetails}
                    contactMap={contactMap}
                    suffix={t.messages.length > 1 ? `${t.messages.length} messages` : undefined}
                  />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted-foreground">{fmtDate(t.latestDate)}</span>
                <button
                  onClick={() =>
                    openCompose({
                      to: to ?? undefined,
                      subject: t.subject.startsWith("Re:") ? t.subject : `Re: ${t.subject}`,
                      threadId: t.threadId,
                      contactId: t.contactId ?? undefined,
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-surface-container-high"
                  aria-label="Reply in this thread"
                >
                  <Reply className="h-3.5 w-3.5" />
                  Reply
                </button>
              </div>
            </div>

            {isExpanded && (
              <div className="mt-3 space-y-4 border-t border-outline-variant pt-3">
                {t.messages.map((m) => (
                  <SentMessageBody key={m.id} message={m} showMeta={t.messages.length > 1} />
                ))}
              </div>
            )}
          </Row>
        );
      })}
    </ul>
  );
}

/** One sent message inside an expanded thread. Renders the persisted HTML body
 * (DOMPurify-sanitized) when present (CAR-115), falls back to the stored plaintext
 * snippet for messages sent before bodies were saved, and shows a gentle note if
 * neither exists. Never does a live mailbox read: everything comes from the DB payload. */
function SentMessageBody({ message, showMeta }: { message: EmailMessage; showMeta: boolean }) {
  return (
    <div>
      {showMeta && (
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">{fmtDateTime(message.date)}</p>
      )}
      {message.body_html ? (
        <EmailBodyHtml html={message.body_html} />
      ) : message.snippet ? (
        <p className="whitespace-pre-wrap text-sm text-on-surface">{message.snippet}</p>
      ) : (
        <EmailBodyHtml html={null} emptyHint="The text of this email was not saved." />
      )}
    </div>
  );
}

function ScheduledList({
  items,
  contactDetails,
  contactMap,
  onRetry,
  retryingId,
}: {
  items: ScheduledEmail[];
  contactDetails: ContactDetailsMap;
  contactMap: Record<number, string>;
  onRetry: (id: number) => void;
  retryingId: number | null;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Clock className="h-6 w-6" />}
        title="Nothing scheduled"
        hint="Emails you schedule to send later will appear here until they go out."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((s) => {
        const isExpanded = expandedId === s.id;
        return (
          <Row key={s.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : s.id)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse scheduled email" : "Expand to read scheduled email"}
                  className="flex w-full min-w-0 items-start gap-2 text-left"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                  <span className="block min-w-0 truncate text-sm font-medium text-on-surface">{s.subject}</span>
                </button>
                <div className="pl-6">
                  <RecipientMeta
                    contactId={s.matched_contact_id}
                    fallbackName={s.contact_name || s.recipient_email}
                    contactDetails={contactDetails}
                    contactMap={contactMap}
                  />
                </div>
              </div>
              {s.status === "failed" ? (
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
                    title="Sending was interrupted, so this email may not have gone out. Check your Gmail Sent folder, then retry or cancel it."
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Didn&apos;t send
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    disabled={retryingId === s.id}
                    onClick={() => onRetry(s.id)}
                  >
                    {retryingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                    Retry
                  </Button>
                </span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                  <Clock className="h-3 w-3" />
                  {fmtDateTime(s.scheduled_send_at)}
                </span>
              )}
            </div>
            {isExpanded && (
              <div className="mt-3 border-t border-outline-variant pt-3">
                <EmailBodyHtml html={s.body_html} emptyHint="This scheduled email has no body." />
              </div>
            )}
          </Row>
        );
      })}
    </ul>
  );
}

function DraftsList({
  items,
  contactDetails,
  onEdit,
  onCancel,
  cancellingId,
}: {
  items: EmailDraft[];
  contactDetails: ContactDetailsMap;
  onEdit: (draft: EmailDraft) => void;
  onCancel: (draftId: number) => void;
  cancellingId: number | null;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<FileText className="h-6 w-6" />}
        title="No drafts"
        hint="Anything you start writing and leave unfinished is auto-saved here."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((draft) => {
        const isExpanded = expandedId === draft.id;
        return (
          <Row key={draft.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : draft.id)}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse draft" : "Expand to read draft"}
                  className="flex w-full min-w-0 items-start gap-2 text-left"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                  <span className="block min-w-0 truncate text-sm font-medium text-on-surface">
                    {draft.subject || "(no subject)"}
                  </span>
                </button>
                <div className="pl-6">
                  <RecipientMeta
                    contactId={draft.matched_contact_id}
                    fallbackName={draft.contact_name || draft.recipient_email || "No recipient"}
                    contactDetails={contactDetails}
                  />
                  {draft.updated_at ? (
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      Updated {fmtDate(draft.updated_at)}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onEdit(draft)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary hover:bg-surface-container-high"
                  aria-label="Edit draft"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </button>
                <button
                  type="button"
                  disabled={cancellingId !== null}
                  onClick={() => onCancel(draft.id)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-surface-container-high hover:text-on-surface disabled:opacity-50"
                  aria-label="Cancel draft"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </button>
              </div>
            </div>

            {isExpanded && (
              <div className="mt-3 border-t border-outline-variant pt-3">
                <EmailBodyHtml html={draft.body_html} emptyHint="This draft has no body yet." />
              </div>
            )}
          </Row>
        );
      })}
    </ul>
  );
}

/** Countdown under an actionable follow-up: "Expires in N days" while parked, a
 * muted "Expired" chip once it has softly retired (still one-click sendable). The
 * countdown emphasizes (weight + color) in its final stretch. */
function ExpiryLabel({ status, expiresAt }: { status: string; expiresAt: string | null }) {
  if (status === FollowUpMessageStatus.Expired) {
    return (
      <span className="mt-1 inline-flex items-center rounded-full bg-surface-container-high px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        Expired
      </span>
    );
  }
  const days = daysUntil(expiresAt);
  if (days === null) return null;
  const urgent = days <= 3;
  const label =
    days <= 0 ? "Expires today" : days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
  return (
    <span className={`mt-0.5 block text-[11px] ${urgent ? "font-medium text-on-surface" : "text-muted-foreground"}`}>
      {label}
    </span>
  );
}

function FollowUpList({
  items,
  contactDetails,
  onConfirm,
  confirmingId,
  onEdit,
}: {
  items: EmailFollowUp[];
  contactDetails: ContactDetailsMap;
  onConfirm: (messageId: number, replied: boolean) => void;
  confirmingId: number | null;
  onEdit: (fu: EmailFollowUp) => void;
}) {
  const [expandedStepId, setExpandedStepId] = useState<number | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<ArrowUpRight className="h-6 w-6" />}
        title="No active follow-ups"
        hint="Attach a follow-up plan when you send outreach to keep threads warm while you wait for a reply."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((fu) => {
        const { openSteps, actionable, sentCount, total } = followUpProgress(fu);
        return (
          <Row key={fu.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-on-surface">
                  {fu.original_subject || "(no subject)"}
                </p>
                <RecipientMeta
                  contactId={fu.matched_contact_id}
                  fallbackName={fu.contact_name || fu.recipient_email || "Unknown recipient"}
                  contactDetails={contactDetails}
                  suffix={total > 0 ? `${sentCount} of ${total} sent` : undefined}
                />
              </div>
              <button
                type="button"
                onClick={() => onEdit(fu)}
                className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:text-primary"
                title="Edit follow-ups"
                aria-label="Edit follow-ups"
              >
                <Pencil className="h-4 w-4" />
              </button>
            </div>

            {openSteps.length > 0 && (
              <div className="mt-3 space-y-2">
                {openSteps.map((m) => {
                  const chip = openStepChip(m.status);
                  const actionableStep = isActionableFollowUpMessage(m.status);
                  const expired = m.status === FollowUpMessageStatus.Expired;
                  const isExpanded = expandedStepId === m.id;
                  return (
                    <div
                      key={m.id}
                      className={`rounded-lg border p-3 ${
                        actionableStep
                          ? "border-primary/20 bg-primary/5"
                          : "border-outline-variant bg-surface-container-low/40"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => setExpandedStepId(isExpanded ? null : m.id)}
                          aria-expanded={isExpanded}
                          aria-label={
                            isExpanded
                              ? `Collapse step ${m.sequence_number}`
                              : `Expand to read step ${m.sequence_number}`
                          }
                          className={`min-w-0 flex-1 text-left ${expired ? "opacity-60" : ""}`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="shrink-0 text-muted-foreground">
                              {isExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </span>
                            <span className="text-xs font-medium text-on-surface">
                              Step {m.sequence_number}: {m.subject}
                            </span>
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.className}`}
                            >
                              {chip.label}
                            </span>
                          </div>
                          <p className="mt-0.5 pl-5 text-[11px] text-muted-foreground">
                            {m.status === FollowUpMessageStatus.Pending
                              ? `Scheduled ${fmtDate(m.scheduled_send_at)}`
                              : m.status === FollowUpMessageStatus.Expired
                                ? "Still sendable"
                                : `Due ${fmtDate(m.scheduled_send_at)}`}
                          </p>
                          {actionableStep && (
                            <div className="pl-5">
                              <ExpiryLabel status={m.status} expiresAt={m.expires_at} />
                            </div>
                          )}
                        </button>
                        {actionableStep && (
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={confirmingId !== null}
                              onClick={() => onConfirm(m.id, true)}
                            >
                              <Check className="h-3.5 w-3.5" />
                              They replied
                            </Button>
                            <Button
                              size="sm"
                              disabled={confirmingId !== null}
                              onClick={() => onConfirm(m.id, false)}
                            >
                              <Send className="h-3.5 w-3.5" />
                              Send now
                            </Button>
                          </div>
                        )}
                      </div>
                      {isExpanded && (
                        <div className="mt-3 border-t border-outline-variant/60 pt-3">
                          <EmailBodyHtml
                            html={m.body_html}
                            emptyHint="This follow-up step has no body."
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {actionable.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Ready to send. Did {fu.contact_name || "they"} already reply?
              </p>
            )}
          </Row>
        );
      })}
    </ul>
  );
}

function ConnectPrompt() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-16 text-center">
      <InboxIcon className="h-7 w-7 text-muted-foreground" />
      <p className="text-base font-medium text-on-surface">Connect your email to start</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Link your Google account to send outreach, schedule emails, and track follow-ups from here.
      </p>
      <Link href="/settings?tab=integrations" className="mt-1">
        <Button size="md">Go to settings</Button>
      </Link>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-outline-variant bg-surface px-6 py-16 text-center">
      <p className="text-sm font-medium text-on-surface">We could not load your outreach</p>
      <p className="max-w-sm text-sm text-muted-foreground">Please try again in a moment.</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
