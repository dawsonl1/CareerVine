"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import {
  Check,
  Clock,
  ArrowRight,
  MessageSquare,
  Mail,
  Bookmark,
  X,
  Chrome,
  Calendar,
  Plus,
} from "lucide-react";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";

// ── Types ──

export type ActionItemType = "action_item" | "reach_out" | "suggestion";

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
}

type FilterType = "all" | "action_item" | "reach_out" | "suggestion";

interface SnoozeState {
  itemId: string;
  showMenu: boolean;
}

const typeLabels: Record<ActionItemType, { badgeBg: string; badgeText: string; label: string }> = {
  action_item: { badgeBg: "bg-[#fef3c7]", badgeText: "text-[#92400e]", label: "ACTION ITEM" },
  reach_out: { badgeBg: "bg-[#fee2e2]", badgeText: "text-[#991b1b]", label: "REACH OUT" },
  suggestion: { badgeBg: "bg-[#bcebf1]", badgeText: "text-[#001f23]", label: "SUGGESTION" },
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
          className="flex items-center gap-4 py-4 px-5 cursor-pointer hover:bg-surface-container-low transition-colors"
          onClick={item.id === "onboard-log" ? onLogConversation : item.id === "onboard-calendar" ? () => window.location.assign("/settings?tab=integrations") : undefined}
        >
          <div className="w-12 h-12 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
            {item.icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-medium text-foreground">{item.title}</p>
            <p className="text-sm text-muted-foreground">{item.subtitle}</p>
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
  onSnooze: (item: UnifiedActionItem, days: number) => void;
  onDismiss: (item: UnifiedActionItem) => void;
  onSave: (item: UnifiedActionItem) => void;
  onLogInteraction: (contactId: number) => void;
  onDraftEmail: (contactId: number) => void;
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
  isEmpty,
  onLogConversation,
  calendarConnected,
}: UnifiedActionListProps) {
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [snoozeState, setSnoozeState] = useState<SnoozeState | null>(null);

  const counts = useMemo(() => {
    const c = { action_item: 0, reach_out: 0, suggestion: 0 };
    for (const item of items) c[item.type]++;
    return c;
  }, [items]);

  const filteredItems = useMemo(() => {
    if (activeFilter === "all") return items;
    return items.filter((i) => i.type === activeFilter);
  }, [items, activeFilter]);

  const filters: { key: FilterType; label: string }[] = [
    { key: "all", label: "All" },
    { key: "action_item", label: `Action Items (${counts.action_item})` },
    { key: "reach_out", label: `Reach Out (${counts.reach_out})` },
    { key: "suggestion", label: `Suggestions (${counts.suggestion})` },
  ];

  return (
    <div>
      <h2 className="text-xl font-medium text-foreground mb-4">Up Next</h2>

      {/* Filter bar */}
      {!isEmpty && (
        <div className="flex flex-wrap gap-2 mb-5">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setActiveFilter(f.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
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
        <div className="rounded-xl border border-outline-variant overflow-hidden divide-y divide-outline-variant/50">
          {filteredItems.length === 0 ? (
            <div className="py-10 text-center text-base text-muted-foreground">
              No items in this category
            </div>
          ) : (
            filteredItems.map((item) => (
              <ActionListItem
                key={item.id}
                item={item}
                onComplete={onComplete}
                onSnooze={onSnooze}
                onDismiss={onDismiss}
                onSave={onSave}
                onLogInteraction={onLogInteraction}
                onDraftEmail={onDraftEmail}
                snoozeState={snoozeState}
                setSnoozeState={setSnoozeState}
              />
            ))
          )}
        </div>
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
  snoozeState,
  setSnoozeState,
}: {
  item: UnifiedActionItem;
  onComplete: (item: UnifiedActionItem) => void;
  onSnooze: (item: UnifiedActionItem, days: number) => void;
  onDismiss: (item: UnifiedActionItem) => void;
  onSave: (item: UnifiedActionItem) => void;
  onLogInteraction: (contactId: number) => void;
  onDraftEmail: (contactId: number) => void;
  snoozeState: SnoozeState | null;
  setSnoozeState: (s: SnoozeState | null) => void;
}) {
  const labels = typeLabels[item.type];
  const showSnoozeMenu = snoozeState?.itemId === item.id && snoozeState.showMenu;

  return (
    <div className="flex items-center gap-4 py-4 px-5 group hover:bg-surface-container-low transition-colors">
      {/* Avatar */}
      <ContactAvatar
        name={item.contactName}
        photoUrl={item.contactPhotoUrl}
        className="w-12 h-12 text-sm shrink-0"
      />

      {/* Content */}
      <Link href={`/contacts/${item.contactId}`} className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-base font-medium text-foreground truncate">{item.contactName}</p>
          <span className="text-sm text-muted-foreground shrink-0">{item.lastContactedLabel}</span>
        </div>
        <p className="text-sm text-muted-foreground truncate mt-0.5">{item.primaryText}</p>
        <span
          className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${labels.badgeBg} ${labels.badgeText}`}
        >
          {labels.label}
        </span>
      </Link>

      {/* Inline actions */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Complete / did it */}
        <button
          type="button"
          onClick={() => onComplete(item)}
          className="p-2.5 rounded-full text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
          title={item.type === "suggestion" ? "I did this" : "Mark as done"}
        >
          <Check className="h-5 w-5" />
        </button>

        {/* Snooze */}
        <div className="relative">
          <button
            type="button"
            onClick={() =>
              setSnoozeState(showSnoozeMenu ? null : { itemId: item.id, showMenu: true })
            }
            className="p-2.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
            title="Snooze"
          >
            <Clock className="h-5 w-5" />
          </button>
          {showSnoozeMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant py-1.5 min-w-[140px]">
              {[
                { days: 1, label: "1 day" },
                { days: 3, label: "3 days" },
                { days: 7, label: "1 week" },
              ].map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => {
                    onSnooze(item, opt.days);
                    setSnoozeState(null);
                  }}
                  className="w-full text-left px-4 py-2 text-sm text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Type-specific actions */}
        {item.type === "action_item" && (
          <Link
            href={`/contacts/${item.contactId}`}
            className="p-2.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors"
            title="Go to contact"
          >
            <ArrowRight className="h-5 w-5" />
          </Link>
        )}

        {item.type === "reach_out" && (
          <>
            <button
              type="button"
              onClick={() => onLogInteraction(item.contactId)}
              className="p-2.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
              title="Log interaction"
            >
              <MessageSquare className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => onDraftEmail(item.contactId)}
              className="p-2.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
              title="Draft message"
            >
              <Mail className="h-5 w-5" />
            </button>
          </>
        )}

        {item.type === "suggestion" && (
          <>
            <button
              type="button"
              onClick={() => onSave(item)}
              className="p-2.5 rounded-full text-primary hover:bg-primary-container transition-colors cursor-pointer"
              title="Save for later"
            >
              <Bookmark className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => onDismiss(item)}
              className="p-2.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
              title="Dismiss"
            >
              <X className="h-5 w-5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
