"use client";

import { Calendar } from "lucide-react";
import { LoadErrorBanner } from "@/components/ui/load-error-state";
import type {
  ContactMeeting,
  InteractionRow,
  EmailMessage,
  EmailThread,
  CompletedActionEntry,
  TimelineEntry,
  TimelineRowEntry,
} from "@/lib/types";
import { MessageSquare, ArrowUpRight, ArrowDownLeft, CheckCircle, ChevronRight } from "lucide-react";
import { conversationTypeLabel } from "@/lib/constants";
import { buildThreads } from "@/lib/gmail-helpers";

interface ContactTimelineTabProps {
  meetings: ContactMeeting[];
  interactions: InteractionRow[];
  emails: EmailMessage[];
  completedActions: CompletedActionEntry[];
  loading: boolean;
  /**
   * The email read failed, so `emails` below is empty for a reason that has
   * nothing to do with this contact's history (CAR-205 review). This tab MERGES
   * emails into the timeline, so without a surface of its own it renders a
   * relationship history with every email silently missing — and for an
   * email-only contact, the load-empty copy over a failed read. The Emails tab
   * has always shown this failure; the Timeline consumes the same array and
   * never did.
   */
  emailsLoadFailed?: boolean;
  onReloadEmails?: () => void;
  /**
   * Opens the detail view for a row. Every entry kind is clickable (CAR-249):
   * before it, meeting rows carried `cursor-pointer` and called an
   * `onMeetingClick` prop no caller ever passed, so they advertised a click that
   * did nothing, and edit/delete for an interaction existed only as a
   * hover-revealed icon.
   *
   * The detail modal itself lives on the PAGE, not here — this tab renders
   * inside a `SectionBoundary` keyed on `dataGeneration`, so a modal owned here
   * would be unmounted mid-interaction by any background refresh (CAR-204).
   */
  onEntryClick: (entry: TimelineEntry) => void;
  /**
   * Which email threads are expanded, and the toggle for them. Owned by the
   * page for the same reason as the detail modal above: state held in this
   * component is destroyed by every background refresh, so a thread the user
   * opened would silently collapse under them (CAR-260).
   */
  expandedThreads: Set<string>;
  onToggleThread: (threadId: string) => void;
  /**
   * Whether entries the user struck from the record are shown (CAR-260).
   * Off by default: the point of removing something is not seeing it. This is
   * the recovery surface, since restoring happens from the detail modal.
   */
  showRemoved: boolean;
  onToggleShowRemoved: () => void;
}

/** The marker a struck entry carries wherever it is still rendered. */
function RemovedChip() {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-surface-container-high text-muted-foreground shrink-0">
      Removed
    </span>
  );
}

/** One row's shared chrome: the icon bubble, the click target, the hover state. */
function TimelineRow({
  icon,
  onClick,
  label,
  indented = false,
  removed = false,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  /** Accessible name for the row button, which is otherwise a div of spans. */
  label: string;
  /** Set for a message rendered inside an expanded thread stack. */
  indented?: boolean;
  /** Struck from every calculation, and only on screen because "Show removed" is on. */
  removed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={removed ? `${label}. Removed` : label}
      className={`w-full text-left relative flex items-center gap-4 p-4 rounded-[12px] hover:bg-surface-container-low transition-colors cursor-pointer${
        indented ? " pl-12" : ""
      }${removed ? " opacity-55" : ""}`}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
      {removed && <RemovedChip />}
    </button>
  );
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** The circular direction badge an email row carries. */
function EmailIcon({ direction, small = false }: { direction: string | null; small?: boolean }) {
  const box = small ? "w-7 h-7" : "w-9 h-9";
  const glyph = small ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <div className={`${box} rounded-full bg-primary-container flex items-center justify-center shrink-0 z-10`}>
      {direction === "outbound" ? (
        <ArrowUpRight className={`${glyph} text-on-primary-container`} />
      ) : (
        <ArrowDownLeft className={`${glyph} text-on-primary-container`} />
      )}
    </div>
  );
}

/** A single email, rendered either standalone or inside an expanded stack. */
function EmailRow({
  message,
  indented,
  onClick,
}: {
  message: EmailMessage;
  indented?: boolean;
  onClick: () => void;
}) {
  const subject = message.subject || "(no subject)";
  return (
    <TimelineRow
      label={`${subject}${message.date ? `, ${shortDate(message.date)}` : ""}. Open details`}
      onClick={onClick}
      indented={indented}
      removed={message.is_excluded}
      icon={<EmailIcon direction={message.direction} small={indented} />}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-base font-medium text-foreground truncate">{subject}</span>
        <span className="text-sm text-muted-foreground shrink-0">
          {message.date ? shortDate(message.date) : ""}
        </span>
      </div>
      <p className="text-sm text-muted-foreground mt-0.5 truncate">{message.snippet || ""}</p>
    </TimelineRow>
  );
}

/**
 * A multi-message conversation as one row (CAR-260). Collapsed by default: the
 * point is that a back-and-forth is ONE event in the relationship, not six.
 *
 * The messages render as siblings of the header button rather than inside it,
 * because a button nested in a button is invalid and the inner one never
 * receives its click.
 */
function EmailThreadStack({
  thread,
  expanded,
  onToggle,
  onMessageClick,
}: {
  thread: EmailThread;
  expanded: boolean;
  onToggle: () => void;
  onMessageClick: (message: EmailMessage) => void;
}) {
  const count = thread.messages.length;
  const latest = thread.messages[count - 1];
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${thread.subject}, ${count} messages, latest ${shortDate(thread.latestDate)}. ${
          expanded ? "Collapse" : "Expand"
        } conversation`}
        className="w-full text-left relative flex items-center gap-4 p-4 rounded-[12px] hover:bg-surface-container-low transition-colors cursor-pointer"
      >
        <EmailIcon direction={thread.latestDirection} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="text-base font-medium text-foreground truncate">{thread.subject}</span>
            <span className="text-sm text-muted-foreground shrink-0">{shortDate(thread.latestDate)}</span>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5 truncate">
            <span className="font-medium">{count} messages</span>
            {latest?.snippet ? ` · ${latest.snippet}` : ""}
          </p>
        </div>
        <ChevronRight
          className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform${expanded ? " rotate-90" : ""}`}
        />
      </button>

      {expanded && (
        <div className="space-y-1 mt-1">
          {/* Oldest first, matching how the Emails tab reads a conversation. */}
          {thread.messages.map((m) => (
            <EmailRow key={m.gmail_message_id} message={m} indented onClick={() => onMessageClick(m)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ContactTimelineTab({
  meetings,
  interactions,
  emails,
  completedActions,
  loading,
  emailsLoadFailed = false,
  onReloadEmails,
  onEntryClick,
  expandedThreads,
  onToggleThread,
  showRemoved,
  onToggleShowRemoved,
}: ContactTimelineTabProps) {
  // Struck entries are gone from the timeline unless the user asks for them.
  // Belt and braces on the email leg: /api/gmail/emails already withholds them
  // (excluding sets is_hidden, which that route filters) unless the page passes
  // includeExcluded, so this second filter only matters if that ever changes.
  const keep = <T extends { is_excluded?: boolean | null }>(rows: T[]) =>
    showRemoved ? rows : rows.filter((r) => !r.is_excluded);

  const shownMeetings = keep(meetings);
  const shownEmails = keep(emails);
  const shownCompletedActions = keep(completedActions);

  // Every sent email also writes an `interactions` mirror row so last_touch
  // updates (email-send.ts), which rendered one send as two timeline entries.
  // Drop the mirror — but only when the message it mirrors is actually on
  // screen. Keying on presence rather than on `email_message_id != null` is
  // what makes a failed email load degrade to a duplicate row instead of
  // silently swallowing the only surviving record of the send.
  const loadedEmailIds = new Set(shownEmails.map((e) => e.id));
  const ownInteractions = keep(interactions).filter(
    (i) => i.email_message_id == null || !loadedEmailIds.has(i.email_message_id)
  );

  const entries: TimelineRowEntry[] = [
    ...shownMeetings.map((m) => ({ kind: "meeting" as const, date: m.meeting_date, data: m })),
    ...ownInteractions.map((i) => ({ kind: "interaction" as const, date: i.interaction_date, data: i })),
    // Grouped by thread, so a six-message conversation is one row and the count
    // above reflects conversations rather than messages (CAR-260). Placed at the
    // thread's latest date, matching buildThreads' own sort and the Emails tab.
    ...buildThreads(shownEmails).map((t) => ({ kind: "email_thread" as const, date: t.latestDate, data: t })),
    ...shownCompletedActions
      .filter((a) => a.completed_at)
      .map((a) => ({ kind: "completed_action" as const, date: a.completed_at!, data: a })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
          <Calendar className="h-4 w-4" /> Timeline{entries.length > 0 ? ` (${entries.length})` : ""}
        </h4>
        <button
          type="button"
          onClick={onToggleShowRemoved}
          aria-pressed={showRemoved}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0"
        >
          {showRemoved ? "Hide removed" : "Show removed"}
        </button>
      </div>

      {/* A banner rather than the full state: the meetings, interactions and
          completed actions below are still valid and still worth showing. What
          is not acceptable is showing them as though they were the whole
          history when the emails are missing (section f). */}
      {emailsLoadFailed && onReloadEmails && (
        <LoadErrorBanner
          className="mb-4"
          message="Couldn't load this contact's emails, so the timeline below is missing them."
          onRetry={onReloadEmails}
        />
      )}

      {loading ? (
        <div className="flex items-center gap-2.5 text-muted-foreground py-2">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
          <span className="text-sm">Loading...</span>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-1">
          No interactions yet. Use &quot;Schedule/log conversation&quot; above to record your first interaction.
        </p>
      ) : (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-[15px] top-4 bottom-4 w-px bg-outline-variant/50" />

          <div className="space-y-2.5">
            {entries.map((item) => {
              if (item.kind === "meeting") {
                const m = item.data;
                const title = m.title || conversationTypeLabel(m.meeting_type, m.meeting_type_detail) || "Meeting";
                return (
                  <TimelineRow
                    key={`m-${m.id}`}
                    label={`${title}, ${shortDate(item.date)}. Open details`}
                    onClick={() => onEntryClick({ kind: "meeting", date: item.date, data: m })}
                    removed={m.is_excluded}
                    icon={
                      <div className="w-9 h-9 rounded-full bg-secondary-container flex items-center justify-center shrink-0 z-10">
                        <Calendar className="h-4 w-4 text-on-secondary-container" />
                      </div>
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base font-medium text-foreground">{title}</span>
                      <span className="text-sm text-muted-foreground">{shortDate(item.date)}</span>
                    </div>
                    {m.notes && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{m.notes}</p>}
                  </TimelineRow>
                );
              }
              if (item.kind === "interaction") {
                const i = item.data;
                const title = conversationTypeLabel(i.interaction_type, i.interaction_type_detail) || "Interaction";
                return (
                  <TimelineRow
                    key={`i-${i.id}`}
                    label={`${title}, ${shortDate(item.date)}. Open details`}
                    onClick={() => onEntryClick({ kind: "interaction", date: item.date, data: i })}
                    removed={i.is_excluded}
                    icon={
                      <div className="w-9 h-9 rounded-full bg-tertiary-container flex items-center justify-center shrink-0 z-10">
                        <MessageSquare className="h-4 w-4 text-on-tertiary-container" />
                      </div>
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base font-medium text-foreground">{title}</span>
                      <span className="text-sm text-muted-foreground">{shortDate(item.date)}</span>
                    </div>
                    {i.summary && <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{i.summary}</p>}
                  </TimelineRow>
                );
              }
              if (item.kind === "completed_action") {
                const a = item.data;
                return (
                  <TimelineRow
                    key={`ca-${a.id}`}
                    label={`Action completed, ${shortDate(item.date)}: ${a.title}. Open details`}
                    onClick={() => onEntryClick({ kind: "completed_action", date: item.date, data: a })}
                    removed={a.is_excluded}
                    icon={
                      <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center shrink-0 z-10">
                        <CheckCircle className="h-4 w-4 text-primary" />
                      </div>
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base font-medium text-foreground">Action completed</span>
                      <span className="text-sm text-muted-foreground">{shortDate(item.date)}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5 truncate">{a.title}</p>
                  </TimelineRow>
                );
              }
              // email_thread. A lone message keeps the plain row it always had:
              // stack chrome around a "1 messages" conversation is noise.
              const thread = item.data;
              const openMessage = (m: EmailMessage) =>
                onEntryClick({ kind: "email", date: m.date || "", data: m });
              if (thread.messages.length === 1) {
                const only = thread.messages[0];
                return (
                  <EmailRow key={`e-${only.gmail_message_id}`} message={only} onClick={() => openMessage(only)} />
                );
              }
              return (
                <EmailThreadStack
                  key={`t-${thread.threadId}`}
                  thread={thread}
                  expanded={expandedThreads.has(thread.threadId)}
                  onToggle={() => onToggleThread(thread.threadId)}
                  onMessageClick={openMessage}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
