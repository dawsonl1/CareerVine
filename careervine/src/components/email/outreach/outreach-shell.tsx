"use client";

/**
 * Free-tier "Outreach" portal (CAR-102).
 *
 * The destination for free users (capability `outreach:portal`), selected by
 * EmailExperience. Built entirely on the DB-only /api/gmail/inbox payload: the
 * outreach a user has sent, what is scheduled, and their follow-up plans. No live
 * mailbox read (free users hold only the gmail.send scope), so there is no inbox,
 * body-expand, labels, sync, or trash/label actions here. Composing and sending
 * work (send needs only gmail.send), via the shared compose modal.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useCompose } from "@/components/compose-email-context";
import Navigation from "@/components/navigation";
import { buildThreads } from "@/lib/gmail-helpers";
import type { EmailMessage, EmailFollowUp, EmailFollowUpMessage, ScheduledEmail } from "@/lib/types";
import { Send, Clock, Reply, PenSquare, Loader2, Inbox as InboxIcon, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import Link from "next/link";

type OutreachTab = "sent" | "scheduled" | "followups";

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

/** The soonest still-pending message in a sequence, plus how many remain. */
function followUpProgress(fu: EmailFollowUp): { next: EmailFollowUpMessage | null; remaining: number; total: number } {
  const msgs = fu.email_follow_up_messages ?? [];
  const pending = msgs
    .filter((m) => m.status === "pending")
    .sort((a, b) => new Date(a.scheduled_send_at || 0).getTime() - new Date(b.scheduled_send_at || 0).getTime());
  return { next: pending[0] ?? null, remaining: pending.length, total: msgs.length };
}

export function OutreachShell() {
  const { user } = useAuth();
  const { gmailConnected, gmailLoading, openCompose } = useCompose();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState<OutreachTab>("sent");

  const [emails, setEmails] = useState<EmailMessage[]>([]);
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  const [followUps, setFollowUps] = useState<EmailFollowUp[]>([]);
  const [contactMap, setContactMap] = useState<Record<number, string>>({});

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
    if (user) void load();
  }, [user, load]);

  // Sent outreach = the user's outbound messages, grouped into threads.
  const sentThreads = useMemo(
    () => buildThreads(emails.filter((e) => e.direction === "outbound")),
    [emails],
  );

  const nameFor = useCallback(
    (contactId: number | null, fallback: string | null | undefined): string =>
      (contactId != null && contactMap[contactId]) || fallback || "Unknown recipient",
    [contactMap],
  );

  const tabs: { key: OutreachTab; label: string; count: number }[] = [
    { key: "sent", label: "Sent", count: sentThreads.length },
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
              Everything you have sent, what is scheduled next, and your follow-up plans, all in one place.
            </p>
          </div>
          <Button onClick={() => openCompose()} size="md">
            <PenSquare className="h-4 w-4" />
            Compose
          </Button>
        </header>

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
              <SentList threads={sentThreads} nameFor={nameFor} onCompose={() => openCompose()} />
            )}
            {activeTab === "scheduled" && (
              <ScheduledList items={scheduledEmails} nameFor={nameFor} />
            )}
            {activeTab === "followups" && <FollowUpList items={followUps} />}
          </>
        )}
      </main>
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

function SentList({
  threads,
  nameFor,
  onCompose,
}: {
  threads: ReturnType<typeof buildThreads>;
  nameFor: (contactId: number | null, fallback: string | null | undefined) => string;
  onCompose: () => void;
}) {
  const { openCompose } = useCompose();
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
        return (
          <Row key={t.threadId}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-on-surface">{t.subject}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  To {nameFor(t.contactId, to)}
                  {t.messages.length > 1 ? ` · ${t.messages.length} messages` : ""}
                </p>
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
          </Row>
        );
      })}
    </ul>
  );
}

function ScheduledList({
  items,
  nameFor,
}: {
  items: ScheduledEmail[];
  nameFor: (contactId: number | null, fallback: string | null | undefined) => string;
}) {
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
      {items.map((s) => (
        <Row key={s.id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-on-surface">{s.subject}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                To {nameFor(s.matched_contact_id, s.contact_name || s.recipient_email)}
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
              <Clock className="h-3 w-3" />
              {fmtDateTime(s.scheduled_send_at)}
            </span>
          </div>
        </Row>
      ))}
    </ul>
  );
}

function FollowUpList({ items }: { items: EmailFollowUp[] }) {
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
        const { next, remaining, total } = followUpProgress(fu);
        return (
          <Row key={fu.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-on-surface">
                  {fu.original_subject || "(no subject)"}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  To {fu.contact_name || fu.recipient_email || "Unknown recipient"}
                  {total > 0 ? ` · ${total - remaining} of ${total} sent` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                {next ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
                    <Clock className="h-3 w-3" />
                    Next {fmtDate(next.scheduled_send_at)}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Awaiting reply</span>
                )}
              </div>
            </div>
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
