"use client";

import { useState, useRef, useMemo, useCallback, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  ArrowRight,
  MessageSquare,
  Mail,
  Bookmark,
  Pencil,
  X,
  Chrome,
  Calendar,
  Plus,
} from "lucide-react";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";

// ── Action button with colored hover + animated label ──

function ActionButton({
  icon,
  label,
  color,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  color: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="relative flex flex-col items-center">
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="p-3 rounded-full transition-colors duration-150 cursor-pointer"
        style={{
          color: hovered ? color : "var(--color-muted-foreground)",
          backgroundColor: hovered ? `${color}12` : "transparent",
        }}
      >
        <span className="block h-6 w-6">{icon}</span>
      </button>
      <span
        className="absolute top-full mt-0.5 text-[11px] font-medium whitespace-nowrap pointer-events-none transition-all duration-150"
        style={{
          color,
          opacity: hovered ? 1 : 0,
          transform: hovered ? "translateY(0)" : "translateY(-4px)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function ActionLink({
  icon,
  label,
  color,
  href,
}: {
  icon: ReactNode;
  label: string;
  color: string;
  href: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="relative flex flex-col items-center">
      <Link
        href={href}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="p-3 rounded-full transition-colors duration-150"
        style={{
          color: hovered ? color : "var(--color-muted-foreground)",
          backgroundColor: hovered ? `${color}12` : "transparent",
        }}
      >
        <span className="block h-6 w-6">{icon}</span>
      </Link>
      <span
        className="absolute top-full mt-0.5 text-[11px] font-medium whitespace-nowrap pointer-events-none transition-all duration-150"
        style={{
          color,
          opacity: hovered ? 1 : 0,
          transform: hovered ? "translateY(0)" : "translateY(-4px)",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ── Types ──

export type ActionItemType = "action_item" | "reach_out" | "suggestion" | "recently_added";

export interface UnifiedActionItem {
  id: string;
  type: ActionItemType;
  contactId: number;
  contactName: string;
  contactPhotoUrl: string | null;
  primaryText: string;
  secondaryText: string;
  lastContactedLabel: string; // e.g. "Last contacted 3 days ago" or "Never contacted"
  priority: number;
  actionItemId?: number;
  dueAt?: string;
  isOverdue?: boolean;
  daysOverdue?: number;
  daysSinceContact?: number | null;
  suggestion?: Suggestion;
  hasEmail?: boolean;
}

type FilterType = "all" | "action_item" | "reach_out" | "suggestion" | "recently_added";

interface SnoozeState {
  itemId: string;
  showMenu: boolean;
}

// ── Note popover (inline quick-note input) ──

function NotePopover({
  onSave,
  onCancel,
}: {
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler); };
  }, [onCancel]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleSave = async () => {
    if (!text.trim()) return;
    setSaving(true);
    await onSave(text.trim());
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-50 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant w-[280px] animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="p-3">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a quick note..."
          className="w-full h-20 px-3 py-2 text-sm bg-surface-container-low text-foreground rounded-lg border border-outline-variant/50 placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary resize-none"
        />
        <div className="flex items-center justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded-full"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!text.trim() || saving}
            className="px-4 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-full hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export type SnoozeAction =
  | { type: "days"; days: number }
  | { type: "until_next_followup" }
  | { type: "skip_contact" };

const typeLabels: Record<ActionItemType, { badgeBg: string; badgeText: string; label: string }> = {
  action_item: { badgeBg: "bg-[#fef3c7]", badgeText: "text-[#92400e]", label: "ACTION ITEM" },
  reach_out: { badgeBg: "bg-[#fee2e2]", badgeText: "text-[#991b1b]", label: "REACH OUT" },
  suggestion: { badgeBg: "bg-[#bcebf1]", badgeText: "text-[#001f23]", label: "SUGGESTION" },
  recently_added: { badgeBg: "bg-[#e8e0ff]", badgeText: "text-[#3b1f7a]", label: "RECENTLY ADDED" },
};

// ── Onboarding items for new users ──

function OnboardingList({
  onLogConversation,
  calendarConnected,
}: {
  onLogConversation: () => void;
  calendarConnected: boolean;
}) {
  const items = [
    {
      id: "onboard-extension",
      icon: <Chrome className="h-6 w-6 text-[#39656b]" />,
      title: "Install the Chrome extension",
      subtitle: "Add contacts from LinkedIn in one click",
    },
    ...(!calendarConnected
      ? [{
          id: "onboard-calendar",
          icon: <Calendar className="h-6 w-6 text-[#e8a838]" />,
          title: "Connect Google Calendar",
          subtitle: "See today's meetings with contact context",
        }]
      : []),
    {
      id: "onboard-log",
      icon: <Plus className="h-6 w-6 text-primary" />,
      title: "Log your first conversation",
      subtitle: "Capture a recent interaction before details fade",
    },
  ];

  return (
    <div className="divide-y divide-outline-variant/50">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-4 py-5 px-5 cursor-pointer hover:bg-surface-container-low transition-colors"
          onClick={item.id === "onboard-log" ? onLogConversation : item.id === "onboard-calendar" ? () => window.location.assign("/settings?tab=integrations") : undefined}
        >
          <div className="w-14 h-14 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
            {item.icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-medium text-foreground">{item.title}</p>
            <p className="text-base text-muted-foreground">{item.subtitle}</p>
          </div>
          <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
        </div>
      ))}
    </div>
  );
}

// ── Main component ──

interface UnifiedActionListProps {
  items: UnifiedActionItem[];
  loading: boolean;
  onComplete: (item: UnifiedActionItem) => void;
  onSnooze: (item: UnifiedActionItem, action: SnoozeAction) => void;
  onDismiss: (item: UnifiedActionItem) => void;
  onSave: (item: UnifiedActionItem) => void;
  onLogInteraction: (contactId: number) => void;
  onDraftEmail: (contactId: number) => void;
  onNote: (contactId: number, note: string) => Promise<void>;
  onIntro: (contactId: number) => void;
  isEmpty: boolean;
  onLogConversation: () => void;
  calendarConnected: boolean;
}

export function UnifiedActionList({
  items,
  loading,
  onComplete,
  onSnooze,
  onDismiss,
  onSave,
  onLogInteraction,
  onDraftEmail,
  onNote,
  onIntro,
  isEmpty,
  onLogConversation,
  calendarConnected,
}: UnifiedActionListProps) {
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [snoozeState, setSnoozeState] = useState<SnoozeState | null>(null);
  const [notePopoverItemId, setNotePopoverItemId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  // Close snooze dropdown on click outside
  useEffect(() => {
    if (!snoozeState?.showMenu) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't close if clicking inside a snooze menu
      if (target.closest("[data-snooze-menu]")) return;
      setSnoozeState(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [snoozeState?.showMenu]);
  const counts = useMemo(() => {
    const c = { action_item: 0, reach_out: 0, suggestion: 0, recently_added: 0 };
    for (const item of items) c[item.type]++;
    return c;
  }, [items]);

  const filteredItems = useMemo(() => {
    if (activeFilter === "all") return items;
    return items.filter((i) => i.type === activeFilter);
  }, [items, activeFilter]);

  // Use smaller page size if any items in the current view have long text (2-line descriptions)
  const PAGE_SIZE = 5;

  const totalPages = Math.ceil(filteredItems.length / PAGE_SIZE);

  // Clamp page when items are removed (e.g., snooze/complete on last page)
  const clampedPage = totalPages > 0 ? Math.min(page, totalPages - 1) : 0;
  if (clampedPage !== page) setPage(clampedPage);
  const paginatedItems = filteredItems.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  const handleFilterChange = useCallback((key: FilterType) => {
    setActiveFilter(key);
    setPage(0);
  }, []);

  const filters: { key: FilterType; label: string }[] = [
    { key: "all", label: "All" },
    { key: "action_item", label: `Action Items (${counts.action_item})` },
    { key: "reach_out", label: `Reach Out (${counts.reach_out})` },
    { key: "suggestion", label: `Suggestions (${counts.suggestion})` },
    ...(counts.recently_added > 0
      ? [{ key: "recently_added" as FilterType, label: `Recently Added (${counts.recently_added})` }]
      : []),
  ];

  return (
    <div className="min-w-0">
      <h2 className="text-[28px] font-medium text-foreground mb-5">Up Next</h2>

      {/* Filter bar */}
      {!isEmpty && (
        <div className="flex flex-wrap gap-2 mb-5">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => handleFilterChange(f.key)}
              className={`px-5 py-2.5 rounded-full text-base font-medium transition-colors cursor-pointer ${
                activeFilter === f.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface-container-high text-foreground hover:bg-surface-container-highest"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-[88px] rounded-xl bg-surface-container-highest animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state / onboarding */}
      {!loading && isEmpty && (
        <div className="rounded-xl border border-outline-variant overflow-hidden">
          <OnboardingList onLogConversation={onLogConversation} calendarConnected={calendarConnected} />
        </div>
      )}

      {/* Action list */}
      {!loading && !isEmpty && (
        <>
          <div className="rounded-xl border border-outline-variant overflow-hidden divide-y divide-outline-variant/50">
            {filteredItems.length === 0 ? (
              <div className="py-10 text-center text-base text-muted-foreground">
                No items in this category
              </div>
            ) : (
              paginatedItems.map((item) => (
                <ActionListItem
                  key={item.id}
                  item={item}
                  onComplete={onComplete}
                  onSnooze={onSnooze}
                  onDismiss={onDismiss}
                  onSave={onSave}
                  onLogInteraction={onLogInteraction}
                  onDraftEmail={onDraftEmail}
                  onNote={onNote}
                  onIntro={onIntro}
                  snoozeState={snoozeState}
                  setSnoozeState={setSnoozeState}
                  notePopoverItemId={notePopoverItemId}
                  setNotePopoverItemId={setNotePopoverItemId}
                />
              ))
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 px-1">
              <span className="text-sm text-muted-foreground">
                {`${page * PAGE_SIZE + 1} - ${Math.min((page + 1) * PAGE_SIZE, filteredItems.length)} of ${filteredItems.length}`}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-default"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Individual action list item ──

function ActionListItem({
  item,
  onComplete,
  onSnooze,
  onDismiss,
  onSave,
  onLogInteraction,
  onDraftEmail,
  onNote,
  onIntro,
  snoozeState,
  setSnoozeState,
  notePopoverItemId,
  setNotePopoverItemId,
}: {
  item: UnifiedActionItem;
  onComplete: (item: UnifiedActionItem) => void;
  onSnooze: (item: UnifiedActionItem, action: SnoozeAction) => void;
  onDismiss: (item: UnifiedActionItem) => void;
  onSave: (item: UnifiedActionItem) => void;
  onLogInteraction: (contactId: number) => void;
  onDraftEmail: (contactId: number) => void;
  onNote: (contactId: number, note: string) => Promise<void>;
  onIntro: (contactId: number) => void;
  snoozeState: SnoozeState | null;
  setSnoozeState: (s: SnoozeState | null) => void;
  notePopoverItemId: string | null;
  setNotePopoverItemId: (id: string | null) => void;
}) {
  const labels = typeLabels[item.type];
  const showSnoozeMenu = snoozeState?.itemId === item.id && snoozeState.showMenu;

  return (
    <div className="flex items-center gap-5 py-5 px-6 group hover:bg-surface-container-low transition-colors">
      {/* Avatar */}
      <Link href={`/contacts/${item.contactId}`} className="shrink-0">
        <ContactAvatar
          name={item.contactName}
          photoUrl={item.contactPhotoUrl}
          className="w-[60px] h-[60px] text-lg"
        />
      </Link>

      {/* Content */}
      <Link href={`/contacts/${item.contactId}`} className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5">
          <p className="text-xl font-medium text-foreground truncate">{item.contactName}</p>
          <span className="text-base text-muted-foreground shrink-0">{item.lastContactedLabel}</span>
        </div>
        <p
          className="text-lg text-muted-foreground mt-0.5 line-clamp-2"
          ref={(el) => {
            if (el) {
              // Only show title tooltip when text is actually clamped
              if (el.scrollHeight > el.clientHeight) {
                el.title = item.primaryText;
              } else {
                el.removeAttribute("title");
              }
            }
          }}
        >
          {item.primaryText}
        </p>
        <span
          className={`inline-block mt-1 px-3 py-1 rounded text-sm font-medium uppercase tracking-wide ${labels.badgeBg} ${labels.badgeText}`}
        >
          {labels.label}
        </span>
      </Link>

      {/* Inline actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Complete / did it — not for recently added */}
        {item.type !== "recently_added" && (
          <ActionButton
            icon={<Check className="h-6 w-6" />}
            label={item.type === "suggestion" ? "Did this" : "Done"}
            color="#16a34a"
            onClick={() => onComplete(item)}
          />
        )}

        {/* Snooze */}
        <div className="relative">
          <ActionButton
            icon={<Clock className="h-6 w-6" />}
            label="Snooze"
            color="#d97706"
            onClick={() =>
              setSnoozeState(showSnoozeMenu ? null : { itemId: item.id, showMenu: true })
            }
          />
          {showSnoozeMenu && (
            <div data-snooze-menu className="absolute right-0 top-full mt-1 z-50 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant py-1.5 min-w-[180px]">
              {[
                { action: { type: "days" as const, days: 1 }, label: "1 day" },
                { action: { type: "days" as const, days: 3 }, label: "3 days" },
                { action: { type: "days" as const, days: 7 }, label: "1 week" },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => {
                    onSnooze(item, opt.action);
                    setSnoozeState(null);
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                >
                  {opt.label}
                </button>
              ))}
              {/* Type-specific final option */}
              {item.type === "recently_added" ? (
                <button
                  type="button"
                  onClick={() => {
                    onSnooze(item, { type: "skip_contact" });
                    setSnoozeState(null);
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-muted-foreground hover:bg-surface-container-highest transition-colors cursor-pointer border-t border-outline-variant/50 mt-1 pt-2"
                >
                  Skip Contact
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    onSnooze(item, { type: "until_next_followup" });
                    setSnoozeState(null);
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-muted-foreground hover:bg-surface-container-highest transition-colors cursor-pointer border-t border-outline-variant/50 mt-1 pt-2"
                >
                  Until next follow-up
                </button>
              )}
            </div>
          )}
        </div>

        {/* Type-specific actions */}
        {item.type === "action_item" && (
          <ActionLink
            icon={<ArrowRight className="h-6 w-6" />}
            label="Profile"
            color="#475569"
            href={`/contacts/${item.contactId}`}
          />
        )}

        {item.type === "reach_out" && (
          <>
            <ActionButton
              icon={<MessageSquare className="h-6 w-6" />}
              label="Log"
              color="#2563eb"
              onClick={() => onLogInteraction(item.contactId)}
            />
            {item.hasEmail && (
              <ActionButton
                icon={<Mail className="h-6 w-6" />}
                label="Email"
                color="#0d9488"
                onClick={() => onDraftEmail(item.contactId)}
              />
            )}
          </>
        )}

        {item.type === "suggestion" && (
          <>
            <ActionButton
              icon={<Bookmark className="h-6 w-6" />}
              label="Save"
              color="#2d6a30"
              onClick={() => onSave(item)}
            />
            <ActionButton
              icon={<X className="h-6 w-6" />}
              label="Dismiss"
              color="#dc2626"
              onClick={() => onDismiss(item)}
            />
          </>
        )}

        {item.type === "recently_added" && (
          <>
            <ActionButton
              icon={<MessageSquare className="h-6 w-6" />}
              label="Log"
              color="#2563eb"
              onClick={() => onLogInteraction(item.contactId)}
            />
            <div className="relative">
              <ActionButton
                icon={<Pencil className="h-6 w-6" />}
                label="Note"
                color="#7c3aed"
                onClick={() => setNotePopoverItemId(notePopoverItemId === item.id ? null : item.id)}
              />
              {notePopoverItemId === item.id && (
                <NotePopover
                  onSave={async (note) => {
                    await onNote(item.contactId, note);
                    setNotePopoverItemId(null);
                  }}
                  onCancel={() => setNotePopoverItemId(null)}
                />
              )}
            </div>
            {item.hasEmail && (
              <span {...(item.contactName.includes("Dawson") ? { "data-onboarding-target": "intro-button-dawson" } : {})}>
                <ActionButton
                  icon={<Mail className="h-6 w-6" />}
                  label="Intro"
                  color="#0d9488"
                  onClick={() => onIntro(item.contactId)}
                />
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
