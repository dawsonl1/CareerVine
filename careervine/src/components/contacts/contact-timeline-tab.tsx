"use client";

import { Calendar } from "lucide-react";
import { LoadErrorBanner } from "@/components/ui/load-error-state";
import type { ContactMeeting, InteractionRow, EmailMessage, CompletedActionEntry, TimelineEntry } from "@/lib/types";
import { MessageSquare, ArrowUpRight, ArrowDownLeft, CheckCircle } from "lucide-react";
import { conversationTypeLabel } from "@/lib/constants";

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
}

/** One row's shared chrome: the icon bubble, the click target, the hover state. */
function TimelineRow({
  icon,
  onClick,
  label,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  /** Accessible name for the row button, which is otherwise a div of spans. */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="w-full text-left relative flex items-center gap-4 p-4 rounded-[12px] hover:bg-surface-container-low transition-colors cursor-pointer"
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </button>
  );
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
}: ContactTimelineTabProps) {
  const entries: TimelineEntry[] = [
    ...meetings.map((m) => ({ kind: "meeting" as const, date: m.meeting_date, data: m })),
    ...interactions.map((i) => ({ kind: "interaction" as const, date: i.interaction_date, data: i })),
    ...emails.map((e) => ({ kind: "email" as const, date: e.date || "", data: e })),
    ...completedActions
      .filter((a) => a.completed_at)
      .map((a) => ({ kind: "completed_action" as const, date: a.completed_at!, data: a })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div>
      <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2 mb-4">
        <Calendar className="h-4 w-4" /> Timeline{entries.length > 0 ? ` (${entries.length})` : ""}
      </h4>

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
                    onClick={() => onEntryClick(item)}
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
                    onClick={() => onEntryClick(item)}
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
                    onClick={() => onEntryClick(item)}
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
              // email
              const e = item.data;
              const subject = e.subject || "(no subject)";
              return (
                <TimelineRow
                  key={`e-${e.gmail_message_id}`}
                  label={`${subject}${e.date ? `, ${shortDate(e.date)}` : ""}. Open details`}
                  onClick={() => onEntryClick(item)}
                  icon={
                    <div className="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center shrink-0 z-10">
                      {e.direction === "outbound" ? (
                        <ArrowUpRight className="h-4 w-4 text-on-primary-container" />
                      ) : (
                        <ArrowDownLeft className="h-4 w-4 text-on-primary-container" />
                      )}
                    </div>
                  }
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-base font-medium text-foreground truncate">{subject}</span>
                    <span className="text-sm text-muted-foreground shrink-0">
                      {e.date ? shortDate(e.date) : ""}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5 truncate">{e.snippet || ""}</p>
                </TimelineRow>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
