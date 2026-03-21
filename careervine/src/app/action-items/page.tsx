"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getActionItems, updateActionItem, createActionItem, getContacts, getCompletedActionItems, deleteActionItem, replaceContactsForActionItem } from "@/lib/queries";
import { DatePicker } from "@/components/ui/date-picker";
import type { Database } from "@/lib/database.types";
import { CheckSquare, AlertTriangle, Check, Pencil, Calendar, X, Plus, Trash2, RotateCcw, ChevronDown, Clock, CalendarDays, Minus, Sparkles, Bookmark, Hourglass, Handshake } from "lucide-react";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { ActionItemSource, ActionDirection } from "@/lib/constants";
import { useSuggestions } from "@/hooks/use-suggestions";
import { Select } from "@/components/ui/select";
import { useDeferredAction } from "@/hooks/use-deferred-action";
import { PRIORITY_COLORS, PRIORITY_OPTIONS, sortByPriorityThenDate } from "@/lib/priority-helpers";

type MeetingRow = Database["public"]["Tables"]["meetings"]["Row"];
type ActionItem = Database["public"]["Tables"]["follow_up_action_items"]["Row"] & {
  contacts: Database["public"]["Tables"]["contacts"]["Row"] | null;
  meetings: MeetingRow | null;
  action_item_contacts?: { contact_id: number; contacts: { id: number; name: string } | null }[];
};

import { inputClasses } from "@/lib/form-styles";
import { useQuickCapture } from "@/components/quick-capture-context";

export default function ActionItemsPage() {
  const { user } = useAuth();
  const { toast, success: toastSuccess, error: toastError } = useToast();
  const { open: openQuickCapture } = useQuickCapture();
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [completedItems, setCompletedItems] = useState<ActionItem[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(true);

  // Smart suggestions
  const [suggestionsCollapsed, setSuggestionsCollapsed] = useState(false);

  // Detail modal
  const [selectedItem, setSelectedItem] = useState<ActionItem | null>(null);

  // Edit modal
  const [editingItem, setEditingItem] = useState<ActionItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editContactIds, setEditContactIds] = useState<number[]>([]);
  const [editMeetingId, setEditMeetingId] = useState<number | null>(null);
  const [editPriority, setEditPriority] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [allContacts, setAllContacts] = useState<{ id: number; name: string }[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [newContactIds, setNewContactIds] = useState<number[]>([]);
  const [newMeetingId, setNewMeetingId] = useState<number | null>(null);
  const [newPriority, setNewPriority] = useState("");
  const [newSaving, setNewSaving] = useState(false);

  const loadContacts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getContacts(user.id);
      setAllContacts((data as { id: number; name: string }[]).map(c => ({ id: c.id, name: c.name })));
    } catch (e) { console.error("Error loading contacts:", e); }
  }, [user]);

  const loadActionItems = useCallback(async () => {
    if (!user) return;
    try {
      const [items, completed] = await Promise.all([
        getActionItems(user.id),
        getCompletedActionItems(user.id),
      ]);
      setActionItems(items as ActionItem[]);
      setCompletedItems(completed as ActionItem[]);
    }
    catch (e) { console.error("Error loading action items:", e); }
    finally { setLoading(false); }
  }, [user]);

  const { suggestions, loading: suggestionsLoading, save: saveSuggestionRaw, complete: completeSuggestionRaw, dismiss: dismissSuggestion, triggerOnce: triggerSuggestions } = useSuggestions({
    onSave: loadActionItems,
  });

  const saveSuggestion = useCallback(async (s: Parameters<typeof saveSuggestionRaw>[0]) => {
    const ok = await saveSuggestionRaw(s);
    if (ok) toastSuccess("Saved as action item");
    else toastError("Failed to save suggestion");
  }, [saveSuggestionRaw, toastSuccess, toastError]);

  const completeSuggestion = useCallback(async (s: Parameters<typeof completeSuggestionRaw>[0]) => {
    const ok = await completeSuggestionRaw(s);
    if (ok) toastSuccess("Marked as done");
    else toastError("Failed to mark as done");
  }, [completeSuggestionRaw, toastSuccess, toastError]);

  useEffect(() => { if (user) { loadActionItems(); loadContacts(); } }, [user, loadActionItems, loadContacts]);

  // Load suggestions once after initial data loads
  useEffect(() => {
    if (!loading) triggerSuggestions();
  }, [loading, triggerSuggestions]);

  const { execute: deferDelete } = useDeferredAction<ActionItem>({
    action: async (item) => { await deleteActionItem(item.id); },
    undoMessage: (item) => `"${item.title}" deleted`,
    onUndo: (item) => {
      if (item.is_completed) {
        setCompletedItems((prev) => prev.some((a) => a.id === item.id) ? prev : [...prev, item]);
      } else {
        setActionItems((prev) => prev.some((a) => a.id === item.id) ? prev : [...prev, item]);
      }
    },
    onError: () => toastError("Failed to delete action item"),
  });

  const { execute: deferComplete } = useDeferredAction<ActionItem>({
    action: async (item) => {
      await updateActionItem(item.id, { is_completed: true, completed_at: new Date().toISOString() });
    },
    undoMessage: (item) => {
      const contactName = item.contacts?.name || item.action_item_contacts?.[0]?.contacts?.name;
      return `Completed${contactName ? ` · ${contactName}` : ""}`;
    },
    onUndo: (item) => {
      setCompletedItems((prev) => prev.filter((a) => a.id !== item.id));
      setActionItems((prev) => prev.some((a) => a.id === item.id) ? prev : [...prev, item]);
    },
    onError: () => toastError("Failed to complete action item"),
    extraActions: (item) => {
      const contactId = item.contacts?.id || item.action_item_contacts?.[0]?.contact_id;
      if (contactId) {
        return [{ label: "Log conversation", onClick: () => openQuickCapture(contactId) }];
      }
      return [];
    },
  });

  const restoreItem = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      await updateActionItem(id, { is_completed: false, completed_at: null });
      await loadActionItems();
      toastSuccess("Action item restored");
    } catch (err) { toastError("Failed to restore action item"); }
  };

  const removeItem = (e: React.MouseEvent, item: ActionItem) => {
    e.stopPropagation();
    setActionItems((prev) => prev.filter((a) => a.id !== item.id));
    setCompletedItems((prev) => prev.filter((a) => a.id !== item.id));
    if (selectedItem?.id === item.id) setSelectedItem(null);
    deferDelete(item);
  };

  const markDone = (e: React.MouseEvent, item: ActionItem) => {
    e.stopPropagation();
    setActionItems((prev) => prev.filter((a) => a.id !== item.id));
    setCompletedItems((prev) => [{ ...item, is_completed: true, completed_at: new Date().toISOString() }, ...prev]);
    if (selectedItem?.id === item.id) setSelectedItem(null);
    deferComplete(item);
  };

  // Track the latest optimistic priority per item to avoid stale-closure reverts on rapid clicks
  const latestPriorityRef = useRef<Map<number, string | null>>(new Map());

  const cyclePriority = async (e: React.MouseEvent, item: ActionItem) => {
    e.stopPropagation();
    const cycle: (string | null)[] = [null, "high", "medium", "low"];
    // Use the latest optimistic value if a cycle is already in-flight
    const currentPriority = latestPriorityRef.current.get(item.id) ?? item.priority;
    const currentIdx = cycle.indexOf(currentPriority);
    const nextPriority = cycle[(currentIdx + 1) % cycle.length];

    latestPriorityRef.current.set(item.id, nextPriority);

    // Optimistic update
    setActionItems((prev) =>
      prev.map((a) => (a.id === item.id ? { ...a, priority: nextPriority } : a))
    );

    try {
      await updateActionItem(item.id, { priority: nextPriority });
    } catch {
      // Revert to the latest optimistic value (not the stale closure value)
      const revertTo = latestPriorityRef.current.get(item.id);
      // Only revert if this call's target is still the latest
      if (revertTo === nextPriority) {
        latestPriorityRef.current.delete(item.id);
        setActionItems((prev) =>
          prev.map((a) => (a.id === item.id ? { ...a, priority: item.priority } : a))
        );
      }
      toastError("Failed to update priority");
    }
  };

  const openEdit = async (e: React.MouseEvent, item: ActionItem) => {
    e.stopPropagation();
    setEditingItem(item);
    setEditTitle(item.title);
    setEditDescription(item.description || "");
    setEditDueDate(item.due_at ? item.due_at.split("T")[0] : "");
    const ids = item.action_item_contacts?.map(ac => ac.contact_id) ?? (item.contact_id ? [item.contact_id] : []);
    setEditContactIds(ids);
    setEditMeetingId(item.meeting_id);
    setEditPriority(item.priority || "");
  };

  const saveEdit = async () => {
    if (!editingItem || !editTitle.trim()) return;
    setEditSaving(true);
    try {
      await updateActionItem(editingItem.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        due_at: editDueDate || null,
        contact_id: editContactIds[0] ?? null,
        meeting_id: editMeetingId,
        priority: editPriority || null,
      });
      await replaceContactsForActionItem(editingItem.id, editContactIds);
      await loadActionItems();
      setEditingItem(null);
      if (selectedItem?.id === editingItem.id) setSelectedItem(null);
      toastSuccess("Action item updated");
    } catch (err) { toastError("Failed to update action item"); }
    finally { setEditSaving(false); }
  };

  const resetCreate = () => {
    setShowCreate(false);
    setNewTitle("");
    setNewDescription("");
    setNewDueDate("");
    setNewContactIds([]);
    setNewMeetingId(null);
    setNewPriority("");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading action items...</span>
          </div>
        </div>
      </div>
    );
  }

  // Separate "waiting on" items from user's own tasks
  const myItems = actionItems.filter((item) => item.direction !== ActionDirection.WaitingOn);
  const waitingOnItems = actionItems.filter((item) => item.direction === ActionDirection.WaitingOn);

  // Group items into four sections
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const endOfWeek = new Date(now);
  endOfWeek.setDate(now.getDate() + (7 - now.getDay()));
  endOfWeek.setHours(23, 59, 59, 999);
  const endOfWeekStr = endOfWeek.toISOString().split("T")[0];

  const overdueItems = myItems
    .filter((item) => item.due_at && item.due_at.split("T")[0] < todayStr)
    .sort(sortByPriorityThenDate);

  const thisWeekItems = myItems
    .filter((item) => item.due_at && item.due_at.split("T")[0] >= todayStr && item.due_at.split("T")[0] <= endOfWeekStr)
    .sort(sortByPriorityThenDate);

  const laterItems = myItems
    .filter((item) => item.due_at && item.due_at.split("T")[0] > endOfWeekStr)
    .sort(sortByPriorityThenDate);

  const noDueDateItems = myItems
    .filter((item) => !item.due_at)
    .sort(sortByPriorityThenDate);

  const totalPending = myItems.length;
  const totalWaiting = waitingOnItems.length;

  const renderPriorityDot = (item: ActionItem) => {
    const p = item.priority as keyof typeof PRIORITY_COLORS | null;
    return (
      <button
        onClick={(e) => cyclePriority(e, item)}
        className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-colors hover:bg-surface-container"
        title={p ? `Priority: ${PRIORITY_COLORS[p].label} (click to change)` : "Set priority"}
      >
        {p ? (
          <span className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[p].dot}`} />
        ) : (
          <span className="w-2 h-2 rounded-full bg-outline-variant opacity-0 group-hover/item:opacity-100 transition-opacity" />
        )}
      </button>
    );
  };

  const isAiGenerated = (item: ActionItem) => item.source !== ActionItemSource.Manual;

  const renderItem = (item: ActionItem, overdue: boolean) => (
    <Card
      key={item.id}
      variant="outlined"
      className={`state-layer cursor-pointer transition-all group/item ${overdue ? "border-destructive/40" : ""}`}
      onClick={() => setSelectedItem(item)}
    >
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${overdue ? "bg-error-container" : "bg-primary-container"}`}>
            {overdue
              ? <AlertTriangle className="h-5 w-5 text-on-error-container" />
              : <CheckSquare className="h-5 w-5 text-on-primary-container" />
            }
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {isAiGenerated(item) && (
                <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
              )}
              {item.direction === ActionDirection.Mutual && (
                <span title="Mutual task"><Handshake className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" /></span>
              )}
              {renderPriorityDot(item)}
              <h3 className="text-base font-medium text-foreground">{item.title}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {(item.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", ")) || item.contacts?.name || "No contact"}
              {item.meetings && <span> · <Calendar className="inline h-3 w-3 mb-0.5" /> {item.meetings.meeting_type}</span>}
              {isAiGenerated(item) && <span> · {item.source === ActionItemSource.AiSuggestion ? "AI suggestion" : "From transcript"}</span>}
            </p>
            {isAiGenerated(item) && item.suggestion_headline && (
              <p className="mt-1 text-sm text-muted-foreground italic line-clamp-1">
                &ldquo;{item.suggestion_evidence || item.suggestion_headline}&rdquo;
              </p>
            )}
            {!isAiGenerated(item) && item.description && (
              <p className="mt-1.5 text-sm text-muted-foreground line-clamp-1">{item.description}</p>
            )}
            <p className={`mt-1.5 text-xs ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}>
              {item.due_at
                ? `${overdue ? "Overdue" : "Due"}: ${new Date(item.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
                : "No due date"}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={(e) => openEdit(e, item)} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
              <Pencil className="h-[18px] w-[18px]" />
            </button>
            <Button variant={overdue ? "danger" : "tonal"} size="sm" onClick={(e) => markDone(e, item)}>
              <Check className="h-4 w-4" /> Done
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  const renderSection = (
    title: string,
    items: ActionItem[],
    icon: React.ReactNode,
    overdue: boolean,
    titleClass = "text-muted-foreground"
  ) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          {icon}
          <h2 className={`text-base font-medium ${titleClass}`}>
            {title} ({items.length})
          </h2>
        </div>
        <div className="space-y-3">
          {items.map((item) => renderItem(item, overdue))}
        </div>
      </div>
    );
  };

  const renderWaitingItem = (item: ActionItem) => {
    const createdDate = item.created_at ? new Date(item.created_at) : null;
    const daysWaiting = createdDate
      ? Math.floor((now.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return (
      <Card
        key={item.id}
        variant="outlined"
        className="state-layer cursor-pointer transition-all group/item"
        onClick={() => setSelectedItem(item)}
      >
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-900/30">
              <Hourglass className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                {isAiGenerated(item) && (
                  <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                )}
                {renderPriorityDot(item)}
                <h3 className="text-base font-medium text-foreground">{item.title}</h3>
              </div>
              <p className="text-sm text-muted-foreground">
                {(item.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", ")) || item.contacts?.name || "No contact"}
                {item.meetings && <span> · <Calendar className="inline h-3 w-3 mb-0.5" /> {item.meetings.meeting_type}</span>}
                {isAiGenerated(item) && <span> · {item.source === ActionItemSource.AiSuggestion ? "AI suggestion" : "From transcript"}</span>}
              </p>
              <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                {daysWaiting !== null ? `${daysWaiting} day${daysWaiting !== 1 ? "s" : ""} waiting` : "Waiting"}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={(e) => openEdit(e, item)} className="state-layer p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
                <Pencil className="h-[18px] w-[18px]" />
              </button>
              <Button variant="tonal" size="sm" onClick={(e) => markDone(e, item)}>
                <Check className="h-4 w-4" /> Done
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const prioritySelect = (value: string, onChange: (val: string) => void) => (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">Priority</label>
      <Select
        value={value}
        onChange={onChange}
        options={PRIORITY_OPTIONS}
        placeholder="No priority"
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-[28px] leading-9 font-normal text-foreground">Action Items</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Follow up on important tasks and commitments
            </p>
          </div>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-[18px] w-[18px]" /> New task
          </Button>
        </div>

        {/* Suggested for you banner */}
        {(suggestionsLoading || (suggestions.length > 0 && !suggestionsCollapsed)) && (
          <Card variant="filled" className="mb-8 border border-primary/10 bg-primary-container/5">
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-primary" />
                  <h2 className="text-base font-medium text-foreground">Suggested for you</h2>
                </div>
                {suggestions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSuggestionsCollapsed(true)}
                    className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    Collapse
                  </button>
                )}
              </div>

              {suggestionsLoading ? (
                <div className="space-y-2">
                  {[1, 2].map((i) => (
                    <div key={i} className="h-16 rounded-[12px] bg-surface-container-highest animate-pulse" />
                  ))}
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {suggestions.map((s) => (
                      <div key={s.id} className="flex items-start gap-3 p-3 rounded-[12px] bg-surface-container hover:bg-surface-container-high transition-colors">
                        <ContactAvatar
                          name={s.contactName}
                          photoUrl={s.contactPhotoUrl}
                          className="w-9 h-9 text-xs shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{s.headline}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {s.suggestedTitle}
                            {s.daysSinceContact !== null && ` · ${s.daysSinceContact}d`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => completeSuggestion(s)}
                            className="p-2 rounded-full text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors cursor-pointer"
                            title="I already did this"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => saveSuggestion(s)}
                            className="p-2 rounded-full text-primary hover:bg-primary-container transition-colors cursor-pointer"
                            title="Save for later"
                          >
                            <Bookmark className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => dismissSuggestion(s)}
                            className="p-2 rounded-full text-muted-foreground hover:text-foreground hover:bg-surface-container-highest transition-colors cursor-pointer"
                            title="Not interested"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-3">
                    These suggestions refresh each visit. Save the ones you want to keep.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        )}

        {suggestions.length > 0 && suggestionsCollapsed && (
          <button
            type="button"
            onClick={() => setSuggestionsCollapsed(false)}
            className="flex items-center gap-2 mb-6 text-sm text-primary hover:underline cursor-pointer"
          >
            <Sparkles className="h-4 w-4" />
            Show {suggestions.length} suggestion{suggestions.length !== 1 ? "s" : ""}
          </button>
        )}

        {/* Sections */}
        {renderSection(
          "Overdue",
          overdueItems,
          <AlertTriangle className="h-5 w-5 text-destructive" />,
          true,
          "text-destructive"
        )}

        {renderSection(
          "Due this week",
          thisWeekItems,
          <CalendarDays className="h-5 w-5 text-primary" />,
          false,
          "text-foreground"
        )}

        {renderSection(
          "Due later",
          laterItems,
          <Clock className="h-5 w-5 text-muted-foreground" />,
          false
        )}

        {renderSection(
          "No due date",
          noDueDateItems,
          <Minus className="h-5 w-5 text-muted-foreground" />,
          false
        )}

        {/* Waiting on others */}
        {waitingOnItems.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <Hourglass className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              <h2 className="text-base font-medium text-amber-600 dark:text-amber-400">
                Waiting on others ({waitingOnItems.length})
              </h2>
            </div>
            <div className="space-y-3">
              {[...waitingOnItems].sort((a, b) => {
                const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
                const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
                return aTime - bTime; // oldest first (most urgent)
              }).map((item) => renderWaitingItem(item))}
            </div>
          </div>
        )}

        {/* Empty state */}
        {totalPending === 0 && totalWaiting === 0 && (
          <Card variant="outlined" className="text-center py-16">
            <CardContent>
              <CheckSquare className="mx-auto h-12 w-12 text-muted-foreground/40 mb-4" />
              <p className="text-base text-foreground mb-1">All clear</p>
              <p className="text-sm text-muted-foreground mb-2">
                No pending action items. Create one to track a follow-up, introduction, or commitment.
              </p>
              <p className="text-xs text-muted-foreground mb-6">
                Action items can also be created from meetings — they&apos;ll automatically link back.
              </p>
              <Button onClick={() => setShowCreate(true)} variant="tonal">
                <Plus className="h-[18px] w-[18px]" /> Create action item
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Completed section */}
        {completedItems.length > 0 && (
          <div className="mt-10">
            <button
              type="button"
              onClick={() => setShowCompleted(!showCompleted)}
              className="flex items-center gap-2 mb-4 text-base font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${showCompleted ? "rotate-0" : "-rotate-90"}`} />
              Completed ({completedItems.length})
            </button>
            {showCompleted && (
              <div className="space-y-3">
                {completedItems.map((item) => (
                  <Card
                    key={item.id}
                    variant="outlined"
                    className="cursor-pointer opacity-70 hover:opacity-100 transition-opacity"
                    onClick={() => setSelectedItem(item)}
                  >
                    <CardContent className="p-5">
                      <div className="flex items-start gap-4">
                        <div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center shrink-0">
                          <Check className="h-5 w-5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="text-base font-medium text-muted-foreground line-through">{item.title}</h3>
                          <p className="text-sm text-muted-foreground">
                            {item.contacts?.name || "No contact"}
                            {item.completed_at && <span> · Completed {new Date(item.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); openEdit(e, item); }} className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer" title="Edit">
                            <Pencil className="h-[18px] w-[18px]" />
                          </button>
                          <button onClick={(e) => restoreItem(e, item.id)} className="p-2 rounded-full text-muted-foreground hover:text-primary cursor-pointer" title="Restore">
                            <RotateCcw className="h-[18px] w-[18px]" />
                          </button>
                          <button onClick={(e) => removeItem(e, item)} className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer" title="Delete">
                            <Trash2 className="h-[18px] w-[18px]" />
                          </button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Detail modal */}
        {selectedItem && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/32" onClick={() => setSelectedItem(null)} />
            <div className="relative w-full max-w-lg bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
              <div className="px-6 pt-6 pb-2 flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-[22px] leading-7 font-normal text-foreground">{selectedItem.title}</h2>
                    {selectedItem.priority && (
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                        PRIORITY_COLORS[selectedItem.priority as keyof typeof PRIORITY_COLORS].badge
                      } capitalize`}>
                        {selectedItem.priority}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{(() => { const names = selectedItem.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", "); return names ? `For ${names}` : selectedItem.contacts ? `For ${selectedItem.contacts.name}` : "No contact assigned"; })()}</p>
                </div>
                <button onClick={() => setSelectedItem(null)} className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="px-6 pb-6 space-y-4">
                {selectedItem.description && (
                  <p className="text-sm text-muted-foreground">{selectedItem.description}</p>
                )}
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>
                    {selectedItem.due_at
                      ? `Due: ${new Date(selectedItem.due_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
                      : "No due date"}
                  </span>
                  {selectedItem.created_at && (
                    <span>Created: {new Date(selectedItem.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                  )}
                </div>

                {selectedItem.meetings && (
                  <div className="pt-3 border-t border-outline-variant">
                    <h3 className="text-sm font-medium text-foreground flex items-center gap-2 mb-3">
                      <Calendar className="h-4 w-4 text-primary" /> Linked meeting
                    </h3>
                    <div className="p-4 rounded-[12px] bg-surface-container">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-medium text-foreground capitalize">{selectedItem.meetings.meeting_type}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(selectedItem.meetings.meeting_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                      {selectedItem.meetings.notes && (
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{selectedItem.meetings.notes}</p>
                      )}
                      {selectedItem.meetings.transcript && (
                        <div className="mt-3 bg-surface-container-low rounded-[8px] p-3 max-h-[60vh] overflow-y-auto">
                          <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{selectedItem.meetings.transcript}</pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex justify-between pt-2">
                  <Button variant="danger" size="sm" onClick={(e) => { removeItem(e, selectedItem); }}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="text" onClick={() => { setSelectedItem(null); openEdit({ stopPropagation: () => {} } as React.MouseEvent, selectedItem); }}>
                      <Pencil className="h-4 w-4" /> Edit
                    </Button>
                    {selectedItem.is_completed ? (
                      <Button variant="tonal" onClick={(e) => { restoreItem(e, selectedItem.id); setSelectedItem(null); }}>
                        <RotateCcw className="h-4 w-4" /> Restore
                      </Button>
                    ) : (
                      <Button onClick={(e) => markDone(e, selectedItem)}>
                        <Check className="h-4 w-4" /> Mark done
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Create modal */}
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/32" onClick={resetCreate} />
            <div className="relative w-full max-w-md bg-surface-container-high rounded-[28px] shadow-lg">
              <div className="px-6 pt-6 pb-4">
                <h2 className="text-[22px] leading-7 font-normal text-foreground">New action item</h2>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className={inputClasses}
                    placeholder="Follow up about..."
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Contacts *</label>
                  <div className="flex flex-wrap gap-2">
                    {allContacts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setNewContactIds(
                          newContactIds.includes(c.id)
                            ? newContactIds.filter((id) => id !== c.id)
                            : [...newContactIds, c.id]
                        )}
                        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium cursor-pointer transition-colors border ${
                          newContactIds.includes(c.id)
                            ? "bg-secondary-container text-on-secondary-container border-secondary-container"
                            : "bg-transparent text-foreground border-outline-variant hover:bg-surface-container"
                        }`}
                      >
                        {newContactIds.includes(c.id) && <Check className="h-3.5 w-3.5" />}
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                  <textarea
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    className={`${inputClasses} !h-auto py-3`}
                    rows={2}
                    placeholder="Optional details..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Due date</label>
                    <DatePicker value={newDueDate} onChange={setNewDueDate} placeholder="No due date" />
                  </div>
                  {prioritySelect(newPriority, setNewPriority)}
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="text" onClick={resetCreate}>Cancel</Button>
                  <Button
                    type="button"
                    disabled={!newTitle.trim() || newContactIds.length === 0 || newSaving}
                    loading={newSaving}
                    onClick={async () => {
                      if (!user || newContactIds.length === 0 || !newTitle.trim()) return;
                      setNewSaving(true);
                      try {
                        await createActionItem({
                          user_id: user.id,
                          contact_id: newContactIds[0],
                          meeting_id: newMeetingId,
                          title: newTitle.trim(),
                          description: newDescription.trim() || null,
                          due_at: newDueDate || null,
                          is_completed: false,
                          created_at: new Date().toISOString(),
                          completed_at: null,
                          priority: newPriority || null,
                        }, newContactIds);
                        resetCreate();
                        await loadActionItems();
                        toastSuccess("Action item created");
                      } catch (err) { toastError("Failed to create action item"); }
                      finally { setNewSaving(false); }
                    }}
                  >
                    Create
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Edit modal */}
        {editingItem && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/32" onClick={() => { setEditingItem(null); }} />
            <div className="relative w-full max-w-lg bg-surface-container-high rounded-[28px] shadow-lg max-h-[95vh] overflow-y-auto">
              <div className="px-6 pt-6 pb-4">
                <h2 className="text-[22px] leading-7 font-normal text-foreground">Edit action item</h2>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Title *</label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className={inputClasses}
                    placeholder="Follow up about..."
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Contacts</label>
                  <div className="flex flex-wrap gap-2">
                    {allContacts.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setEditContactIds(
                          editContactIds.includes(c.id)
                            ? editContactIds.filter((id) => id !== c.id)
                            : [...editContactIds, c.id]
                        )}
                        className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-medium cursor-pointer transition-colors border ${
                          editContactIds.includes(c.id)
                            ? "bg-secondary-container text-on-secondary-container border-secondary-container"
                            : "bg-transparent text-foreground border-outline-variant hover:bg-surface-container"
                        }`}
                      >
                        {editContactIds.includes(c.id) && <Check className="h-3.5 w-3.5" />}
                        {c.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className={`${inputClasses} !h-auto py-3`}
                    rows={3}
                    placeholder="Optional details..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Due date</label>
                    <DatePicker value={editDueDate} onChange={setEditDueDate} placeholder="No due date" />
                  </div>
                  {prioritySelect(editPriority, setEditPriority)}
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="text" onClick={() => { setEditingItem(null); }}>Cancel</Button>
                  <Button type="button" disabled={!editTitle.trim() || editSaving} loading={editSaving} onClick={saveEdit}>
                    Save
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
