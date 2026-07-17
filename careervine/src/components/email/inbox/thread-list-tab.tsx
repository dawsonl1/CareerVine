import { useState, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import {
  Inbox,
  Send,
  Clock,
  ArrowUpRight,
  ArrowDownLeft,
  Reply,
  Trash2,
  EyeOff,
  Eye,
  FolderInput,
  RotateCcw,
  ChevronDown,
  MoreVertical,
  Calendar as CalendarIcon,
} from "lucide-react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { useCompose } from "@/components/compose-email-context";
import { useCursorTooltip } from "@/components/ui/cursor-tooltip";
import { isOpenFollowUpMessage } from "@/lib/constants";
import type { EmailMessage, EmailMessageFull, EmailFollowUp } from "@/lib/types";
import { isWithinDays, type EmailThread } from "@/lib/gmail-helpers";
import type { GmailLabel, TabContext, LinkedCalendarEvent, FollowUpModalPayload } from "./inbox-types";

interface ThreadListTabProps {
  threads: EmailThread[];
  tabCtx: TabContext;
  // Expansion state (owned by the shell's reducer).
  expandedThreadId: string | null;
  expandedEmailId: string | null;
  expandedEmailContent: EmailMessageFull | null;
  loadingEmailContent: boolean;
  onThreadClick: (thread: EmailThread) => void;
  onExpandEmail: (gmailMessageId: string) => void;
  // Shared read-only data.
  contactMap: Record<number, string>;
  gmailLabels: GmailLabel[];
  followUpsByThread: Record<string, EmailFollowUp[]>;
  calendarByThread: Record<string, LinkedCalendarEvent>;
  // Mutations (optimistic + rollback live in the shell).
  onTrash: (gmailMessageId: string, e?: React.MouseEvent) => void;
  onRestore: (gmailMessageId: string, e?: React.MouseEvent) => void;
  onHide: (gmailMessageId: string, e?: React.MouseEvent) => void;
  onUnhide: (gmailMessageId: string, e?: React.MouseEvent) => void;
  onMove: (gmailMessageId: string, labelId: string) => void;
  onViewContact: (contactId: number) => void;
  onOpenFollowUp: (payload: FollowUpModalPayload) => void;
  // Empty-state copy context.
  searchQuery: string;
  selectedContactId: number | null;
  activeFilterCount: number;
  formatDate: (dateStr: string) => string;
  formatDateFull: (dateStr: string) => string;
}

/**
 * The four mailbox views (inbox / sent / trash / hidden) render as this one
 * component with a different `tabCtx` and thread list. All thread-list-only UI
 * state — the two move dropdowns, the 3-dot action menu, and the direction-arrow
 * tooltip — is owned here, not by the shell (CAR-150). Switching tabs unmounts
 * this component, so that transient UI state resets for free.
 */
export function ThreadListTab({
  threads,
  tabCtx,
  expandedThreadId,
  expandedEmailId,
  expandedEmailContent,
  loadingEmailContent,
  onThreadClick,
  onExpandEmail,
  contactMap,
  gmailLabels,
  followUpsByThread,
  calendarByThread,
  onTrash,
  onRestore,
  onHide,
  onUnhide,
  onMove,
  onViewContact,
  onOpenFollowUp,
  searchQuery,
  selectedContactId,
  activeFilterCount,
  formatDate,
  formatDateFull,
}: ThreadListTabProps) {
  const { openCompose } = useCompose();

  // Move-to-folder dropdown (collapsed row + expanded action bar share it).
  const [moveDropdownMsgId, setMoveDropdownMsgId] = useState<string | null>(null);
  const moveDropdownRef = useRef<HTMLDivElement>(null);

  // Thread action menu (3-dot).
  const [threadActionMenuId, setThreadActionMenuId] = useState<string | null>(null);
  const [threadActionMoveOpen, setThreadActionMoveOpen] = useState(false);
  const threadActionRef = useRef<HTMLDivElement>(null);

  // Direction-arrow hover tooltip (shared across thread rows + expanded messages).
  const [hoveredArrow, setHoveredArrow] = useState<"inbound" | "outbound" | null>(null);
  const { posRef: arrowPosRef, tooltipRef: arrowTooltipRef, handleMouseMove: handleArrowMouseMove } = useCursorTooltip();

  useClickOutside(moveDropdownRef, useCallback(() => setMoveDropdownMsgId(null), []), !!moveDropdownMsgId);
  useClickOutside(threadActionRef, useCallback(() => { setThreadActionMenuId(null); setThreadActionMoveOpen(false); }, []), !!threadActionMenuId);

  // Seed the tooltip at the last cursor position when it first appears; every
  // subsequent move repositions it imperatively via handleArrowMouseMove. Doing
  // this in a layout effect (not in render) keeps the ref read out of the render
  // path — `handleArrowMouseMove` owns the mutable position, render never reads it.
  useLayoutEffect(() => {
    const el = arrowTooltipRef.current;
    if (hoveredArrow && el) {
      el.style.left = `${arrowPosRef.current.x + 14}px`;
      el.style.top = `${arrowPosRef.current.y - 44}px`;
    }
  }, [hoveredArrow, arrowTooltipRef, arrowPosRef]);

  // ── Inline action icons for collapsed message rows ──

  const renderMsgRowActions = (msg: EmailMessage, tab: TabContext) => (
    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover/msg:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
      {tab === "trash" && (
        <button type="button" onClick={(e) => onRestore(msg.gmail_message_id, e)} className="p-1.5 rounded-full text-muted-foreground hover:text-primary transition-colors cursor-pointer" title="Restore">
          <RotateCcw className="h-4 w-4" />
        </button>
      )}
      {tab === "hidden" && (
        <button type="button" onClick={(e) => onUnhide(msg.gmail_message_id, e)} className="p-1.5 rounded-full text-muted-foreground hover:text-primary transition-colors cursor-pointer" title="Unhide">
          <Eye className="h-4 w-4" />
        </button>
      )}
      {(tab === "inbox" || tab === "sent") && (
        <>
          {gmailLabels.length > 0 && (
            <div className="relative" ref={moveDropdownMsgId === msg.gmail_message_id ? moveDropdownRef : undefined}>
              <button
                type="button"
                className="p-1.5 rounded-full text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title="Move to folder"
                onClick={(e) => { e.stopPropagation(); setMoveDropdownMsgId(moveDropdownMsgId === msg.gmail_message_id ? null : msg.gmail_message_id); }}
              >
                <FolderInput className="h-4 w-4" />
              </button>
              {moveDropdownMsgId === msg.gmail_message_id && (
                <div className="absolute right-0 top-8 z-50 w-52 max-h-60 overflow-y-auto bg-surface-container-high rounded-xl shadow-lg border border-outline-variant py-1">
                  {gmailLabels.map((label) => (
                    <button key={label.id} type="button" className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors" onClick={(e) => { e.stopPropagation(); setMoveDropdownMsgId(null); onMove(msg.gmail_message_id, label.id); }}>
                      {label.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button type="button" onClick={(e) => onHide(msg.gmail_message_id, e)} className="p-1.5 rounded-full text-muted-foreground hover:text-foreground transition-colors cursor-pointer" title="Hide from app">
            <EyeOff className="h-4 w-4" />
          </button>
          <button type="button" onClick={(e) => onTrash(msg.gmail_message_id, e)} className="p-1.5 rounded-full text-muted-foreground hover:text-destructive transition-colors cursor-pointer" title="Trash">
            <Trash2 className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );

  // ── Full action bar for expanded email content ──

  const renderEmailActions = (msg: EmailMessage, thread: EmailThread, contactName: string | null, tab: TabContext) => (
    <div className="mt-4 pt-4 border-t border-outline-variant/50 flex items-center gap-4 flex-wrap">
      {tab !== "trash" && tab !== "hidden" && (
        <button
          type="button"
          className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors"
          onClick={() => {
            if (!expandedEmailContent) return;
            const replyTo = msg.direction === "outbound" ? (msg.to_addresses?.[0] || "") : (msg.from_address || "");
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
          <Reply className="h-4 w-4" />
          Reply
        </button>
      )}
      {tab !== "trash" && tab !== "hidden" && msg.direction === "outbound" && isWithinDays(msg.date, 14) && (
        <button
          type="button"
          className="inline-flex items-center gap-2 text-sm font-medium text-tertiary hover:text-tertiary/80 cursor-pointer transition-colors"
          onClick={() => {
            onOpenFollowUp({
              recipientEmail: msg.to_addresses?.[0] || "",
              contactName: contactName || null,
              originalSubject: expandedEmailContent?.subject || thread.subject,
              originalSentAt: msg.date!,
              originalGmailMessageId: msg.gmail_message_id,
              threadId: thread.threadId,
            });
          }}
        >
          <Clock className="h-4 w-4" />
          Follow-up
        </button>
      )}
      {contactName && thread.contactId && (
        <button
          type="button"
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          onClick={() => onViewContact(thread.contactId!)}
        >
          View contact
        </button>
      )}

      <div className="flex-1" />

      {/* Move to folder */}
      {(tab === "inbox" || tab === "sent") && gmailLabels.length > 0 && (
        <div className="relative" ref={moveDropdownMsgId === msg.gmail_message_id ? moveDropdownRef : undefined}>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            onClick={(e) => { e.stopPropagation(); setMoveDropdownMsgId(moveDropdownMsgId === msg.gmail_message_id ? null : msg.gmail_message_id); }}
          >
            <FolderInput className="h-4 w-4" />
            Move to
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          {moveDropdownMsgId === msg.gmail_message_id && (
            <div className="absolute right-0 bottom-7 z-50 w-52 max-h-60 overflow-y-auto bg-surface-container-high rounded-xl shadow-lg border border-outline-variant py-1">
              {gmailLabels.map((label) => (
                <button key={label.id} type="button" className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors" onClick={(e) => { e.stopPropagation(); setMoveDropdownMsgId(null); onMove(msg.gmail_message_id, label.id); }}>
                  {label.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Hide / Unhide */}
      {tab === "hidden" ? (
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 cursor-pointer transition-colors" onClick={() => onUnhide(msg.gmail_message_id)}>
          <Eye className="h-4 w-4" />
          Unhide
        </button>
      ) : tab !== "trash" ? (
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground cursor-pointer transition-colors" onClick={() => onHide(msg.gmail_message_id)} title="Hide from webapp (keeps in Gmail)">
          <EyeOff className="h-4 w-4" />
          Hide
        </button>
      ) : null}

      {/* Trash / Restore */}
      {tab === "trash" ? (
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 cursor-pointer transition-colors" onClick={() => onRestore(msg.gmail_message_id)}>
          <RotateCcw className="h-4 w-4" />
          Restore
        </button>
      ) : tab !== "hidden" ? (
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-destructive cursor-pointer transition-colors" onClick={() => onTrash(msg.gmail_message_id)} title="Move to trash (Gmail + webapp)">
          <Trash2 className="h-4 w-4" />
          Trash
        </button>
      ) : null}
    </div>
  );

  // ── Render expanded email body ──

  const renderExpandedContent = (msg: EmailMessage, thread: EmailThread, contactName: string | null, tab: TabContext) => (
    <div className="p-5 rounded-lg bg-surface-container-low border border-outline-variant/50">
      {loadingEmailContent ? (
        <div className="flex items-center gap-2.5 text-muted-foreground text-sm py-5">
          <div className="animate-spin rounded-full h-4 w-4 border border-primary border-t-transparent" />
          Loading email…
        </div>
      ) : expandedEmailContent ? (
        <div>
          <div className="text-sm text-muted-foreground space-y-1 mb-4">
            <p><span className="font-medium">From:</span> {expandedEmailContent.from}</p>
            <p><span className="font-medium">To:</span> {expandedEmailContent.to}</p>
            <p><span className="font-medium">Date:</span> {expandedEmailContent.date ? new Date(expandedEmailContent.date).toLocaleString() : ""}</p>
          </div>
          {expandedEmailContent.bodyHtml ? (
            <div className="text-base prose prose-base max-w-none [&_*]:!text-foreground [&_a]:!text-primary overflow-auto" style={{ maxHeight: "calc(100vh - 380px)", minHeight: "200px" }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(expandedEmailContent.bodyHtml) }} />
          ) : (
            <pre className="text-base text-foreground whitespace-pre-wrap overflow-auto" style={{ maxHeight: "calc(100vh - 380px)", minHeight: "200px" }}>{expandedEmailContent.bodyText || "No content available"}</pre>
          )}
          {renderEmailActions(msg, thread, contactName, tab)}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Failed to load email content.</p>
      )}
    </div>
  );

  if (threads.length === 0) {
    const iconMap: Record<string, typeof Inbox> = { inbox: Inbox, sent: Send, trash: Trash2, hidden: EyeOff };
    const EmptyIcon = iconMap[tabCtx] || Inbox;
    const msgMap: Record<string, string> = {
      inbox: searchQuery || selectedContactId || activeFilterCount > 0 ? "No emails match your filters." : "No emails synced yet.",
      sent: "No sent emails yet.",
      trash: "Trash is empty.",
      hidden: "No hidden emails.",
    };
    return (
      <div className="text-center py-16">
        <EmptyIcon className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
        <p className="text-base text-muted-foreground">{msgMap[tabCtx]}</p>
      </div>
    );
  }

  return (
    <>
      <div className="border border-outline-variant/50 rounded-xl overflow-hidden divide-y divide-outline-variant/50">
        {threads.map((thread) => {
          const isExpanded = expandedThreadId === thread.threadId;
          const latest = thread.messages[thread.messages.length - 1];
          const contactName = thread.contactId ? contactMap[thread.contactId] : null;
          const isUnread = tabCtx === "inbox" && thread.messages.some((m) => !m.is_read && m.direction === "inbound");
          const threadFUs = followUpsByThread[thread.threadId] || [];
          const pendingFUCount = threadFUs.reduce((sum, fu) => sum + fu.email_follow_up_messages.filter((m) => isOpenFollowUpMessage(m.status)).length, 0);
          const linkedCalEvent = calendarByThread[thread.threadId] || null;
          const isSingle = thread.messages.length === 1;

          return (
            <div key={thread.threadId} className={isExpanded ? "bg-surface-container-low/30" : ""}>
              {/* Thread row */}
              <button
                type="button"
                className={`group/thread w-full text-left px-5 py-3.5 hover:bg-surface-container-low transition-colors cursor-pointer ${isUnread ? "bg-primary/[0.04]" : ""}`}
                onClick={() => { setMoveDropdownMsgId(null); onThreadClick(thread); }}
              >
                <div className="flex items-center gap-3.5">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      tabCtx === "trash" ? "bg-surface-container-low" :
                      tabCtx === "hidden" ? "bg-surface-container-low" :
                      latest.direction === "outbound" ? "bg-primary-container" : "bg-tertiary-container"
                    }`}
                    onMouseEnter={tabCtx !== "trash" && tabCtx !== "hidden" ? () => setHoveredArrow(latest.direction as "inbound" | "outbound") : undefined}
                    onMouseLeave={tabCtx !== "trash" && tabCtx !== "hidden" ? () => setHoveredArrow(null) : undefined}
                    onMouseMove={tabCtx !== "trash" && tabCtx !== "hidden" ? handleArrowMouseMove : undefined}
                  >
                    {tabCtx === "trash" ? <Trash2 className="h-4 w-4 text-muted-foreground" /> :
                     tabCtx === "hidden" ? <EyeOff className="h-4 w-4 text-muted-foreground" /> :
                     latest.direction === "outbound" ? <ArrowUpRight className="h-4 w-4 text-on-primary-container" /> :
                     <ArrowDownLeft className="h-4 w-4 text-on-tertiary-container" />}
                  </div>
                  <div className="w-40 shrink-0 truncate">
                    <span className={`text-base ${isUnread ? "font-semibold text-foreground" : "text-foreground"}`}>
                      {contactName || (latest.direction === "outbound" ? `To: ${latest.to_addresses?.[0] || "Unknown"}` : latest.from_address || "Unknown")}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0 flex items-center gap-2.5">
                    <span className={`text-base truncate ${isUnread ? "font-semibold text-foreground" : "text-foreground"}`}>{thread.subject}</span>
                    {thread.messages.length > 1 && (
                      <span className="inline-flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-secondary-container text-[10px] font-medium text-on-secondary-container shrink-0">{thread.messages.length}</span>
                    )}
                    {pendingFUCount > 0 && (
                      <span className="inline-flex items-center gap-0.5 h-4 px-1.5 rounded-full bg-tertiary-container/50 text-[10px] font-medium text-on-tertiary-container shrink-0">
                        <Clock className="h-2.5 w-2.5" />{pendingFUCount}
                      </span>
                    )}
                    {linkedCalEvent && (
                      <span
                        className="inline-flex items-center gap-0.5 h-4 px-1.5 rounded-full bg-primary/10 text-[10px] font-medium text-primary shrink-0"
                        title={`Meeting scheduled: ${linkedCalEvent.title || "Untitled"} · ${new Date(linkedCalEvent.start_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                      >
                        <CalendarIcon className="h-2.5 w-2.5" />
                      </span>
                    )}
                    <span className="text-sm text-muted-foreground truncate hidden sm:inline">{latest.snippet || ""}</span>
                  </div>
                  <span className={`text-sm shrink-0 ${isUnread ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                    {thread.latestDate ? formatDate(thread.latestDate) : ""}
                  </span>
                  {/* 3-dot action menu */}
                  <div className="relative shrink-0" ref={threadActionMenuId === thread.threadId ? threadActionRef : undefined}>
                    <div
                      role="button"
                      tabIndex={0}
                      className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-low transition-colors cursor-pointer opacity-0 group-hover/thread:opacity-100"
                      title="Actions"
                      onClick={(e) => { e.stopPropagation(); setThreadActionMenuId(threadActionMenuId === thread.threadId ? null : thread.threadId); setThreadActionMoveOpen(false); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setThreadActionMenuId(thread.threadId); } }}
                    >
                      <MoreVertical className="h-5 w-5" />
                    </div>
                    {threadActionMenuId === thread.threadId && (
                      <div className="absolute right-0 top-9 z-50 w-48 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant py-1" onClick={(e) => e.stopPropagation()}>
                        {/* Reply */}
                        {tabCtx !== "trash" && tabCtx !== "hidden" && (
                          <button
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors flex items-center gap-3"
                            onClick={() => {
                              const lastMsg = thread.messages[thread.messages.length - 1];
                              const replyTo = lastMsg.direction === "outbound" ? (lastMsg.to_addresses?.[0] || "") : (lastMsg.from_address || "");
                              const subj = thread.subject.replace(/^(Re:\s*)+/i, "");
                              openCompose({ to: replyTo, name: contactName || undefined, subject: `Re: ${subj}`, threadId: thread.threadId, inReplyTo: lastMsg.gmail_message_id, references: lastMsg.gmail_message_id });
                              setThreadActionMenuId(null);
                            }}
                          >
                            <Reply className="h-4 w-4 text-muted-foreground" /> Reply
                          </button>
                        )}
                        {/* Move to */}
                        {(tabCtx === "inbox" || tabCtx === "sent") && gmailLabels.length > 0 && (
                          <div className="relative">
                            <button
                              type="button"
                              className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors flex items-center gap-3"
                              onClick={() => setThreadActionMoveOpen(!threadActionMoveOpen)}
                            >
                              <FolderInput className="h-4 w-4 text-muted-foreground" /> Move to
                              <ChevronDown className={`h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform ${threadActionMoveOpen ? "rotate-180" : ""}`} />
                            </button>
                            {threadActionMoveOpen && (
                              <div className="border-t border-outline-variant/50 max-h-44 overflow-y-auto">
                                {gmailLabels.map((label) => (
                                  <button
                                    key={label.id}
                                    type="button"
                                    className="w-full text-left px-4 pl-11 py-2 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors"
                                    onClick={() => { onMove(latest.gmail_message_id, label.id); setThreadActionMenuId(null); setThreadActionMoveOpen(false); }}
                                  >
                                    {label.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {/* Hide */}
                        {tabCtx === "hidden" ? (
                          <button
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors flex items-center gap-3"
                            onClick={() => { onUnhide(latest.gmail_message_id); setThreadActionMenuId(null); }}
                          >
                            <Eye className="h-4 w-4 text-muted-foreground" /> Unhide
                          </button>
                        ) : tabCtx !== "trash" ? (
                          <button
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors flex items-center gap-3"
                            onClick={() => { onHide(latest.gmail_message_id); setThreadActionMenuId(null); }}
                          >
                            <EyeOff className="h-4 w-4 text-muted-foreground" /> Hide
                          </button>
                        ) : null}
                        {/* Trash / Restore */}
                        {tabCtx === "trash" ? (
                          <button
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-sm text-foreground hover:bg-surface-container-low cursor-pointer transition-colors flex items-center gap-3"
                            onClick={() => { onRestore(latest.gmail_message_id); setThreadActionMenuId(null); }}
                          >
                            <RotateCcw className="h-4 w-4 text-muted-foreground" /> Restore
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="w-full text-left px-4 py-2.5 text-sm text-destructive hover:bg-surface-container-low cursor-pointer transition-colors flex items-center gap-3"
                            onClick={() => { onTrash(latest.gmail_message_id); setThreadActionMenuId(null); }}
                          >
                            <Trash2 className="h-4 w-4" /> Trash
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </button>

              {/* Expanded view */}
              {isExpanded && (
                <div className="px-5 pb-4">
                  {isSingle ? (
                    /* Single message: content shown directly */
                    <div className="ml-5 pl-5 pt-1">
                      {renderExpandedContent(thread.messages[0], thread, contactName, tabCtx)}
                    </div>
                  ) : (
                    /* Multi-message thread */
                    <div className="ml-5 border-l-2 border-outline-variant/50 pl-5 space-y-2 pt-1">
                      {thread.messages.map((msg) => {
                        const isMsgExpanded = expandedEmailId === msg.gmail_message_id;
                        return (
                          <div key={msg.gmail_message_id} className="rounded-lg border border-outline-variant/40 overflow-hidden">
                            {/* Message header row */}
                            <div className="group/msg flex items-center gap-2.5 p-3 hover:bg-surface-container-low/80 transition-colors cursor-pointer" onClick={() => onExpandEmail(msg.gmail_message_id)}>
                              <span
                                className="shrink-0 flex items-center"
                                onMouseEnter={() => setHoveredArrow(msg.direction as "inbound" | "outbound")}
                                onMouseLeave={() => setHoveredArrow(null)}
                                onMouseMove={handleArrowMouseMove}
                              >
                                {msg.direction === "outbound" ? (
                                  <ArrowUpRight className="h-3.5 w-3.5 text-primary" />
                                ) : (
                                  <ArrowDownLeft className="h-3.5 w-3.5 text-tertiary" />
                                )}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2.5">
                                  <span className={`text-sm font-medium truncate ${!msg.is_read && msg.direction === "inbound" ? "text-foreground font-semibold" : "text-foreground"}`}>
                                    {msg.direction === "outbound" ? "You" : (contactName || msg.from_address || "Unknown")}
                                  </span>
                                  <span className="text-xs text-muted-foreground shrink-0">{msg.date ? formatDateFull(msg.date) : ""}</span>
                                </div>
                                {!isMsgExpanded && <p className="text-sm text-muted-foreground truncate mt-0.5">{msg.snippet || ""}</p>}
                              </div>
                              {!isMsgExpanded && renderMsgRowActions(msg, tabCtx)}
                            </div>

                            {/* Expanded message content */}
                            {isMsgExpanded && (
                              <div className="px-3 pb-3">
                                {renderExpandedContent(msg, thread, contactName, tabCtx)}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Quick reply at thread bottom */}
                      {tabCtx !== "trash" && tabCtx !== "hidden" && (
                        <div className="pl-2.5 pt-1.5 pb-1.5 flex items-center gap-5">
                          <button
                            type="button"
                            className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/80 cursor-pointer transition-colors"
                            onClick={() => {
                              const lastMsg = thread.messages[thread.messages.length - 1];
                              const replyTo = lastMsg.direction === "outbound" ? (lastMsg.to_addresses?.[0] || "") : (lastMsg.from_address || "");
                              const subj = thread.subject.replace(/^(Re:\s*)+/i, "");
                              openCompose({ to: replyTo, name: contactName || undefined, subject: `Re: ${subj}`, threadId: thread.threadId, inReplyTo: lastMsg.gmail_message_id, references: lastMsg.gmail_message_id });
                            }}
                          >
                            <Reply className="h-4 w-4" />
                            Reply
                          </button>
                          {thread.contactId && (
                            <button type="button" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors" onClick={() => onViewContact(thread.contactId!)}>
                              View contact
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Direction-arrow cursor tooltip */}
      {hoveredArrow && createPortal(
        <div
          ref={arrowTooltipRef}
          className="fixed z-[9999] px-4 py-2.5 rounded-xl bg-surface-container-highest border border-outline-variant shadow-lg pointer-events-none"
        >
          <p className="text-sm text-foreground whitespace-nowrap">
            {hoveredArrow === "outbound" ? "Outgoing: you sent this" : "Incoming: sent to you"}
          </p>
        </div>,
        document.body
      )}
    </>
  );
}
