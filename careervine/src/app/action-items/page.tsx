/**
 * Action Items page — M3 styled task management
 *
 * Displays pending and completed action items for the authenticated user.
 *
 * Features:
 *   - Pending items list with contact chips, due dates, overdue highlighting
 *   - Completed items section (collapsible)
 *   - Create modal: title, description, contacts (ContactPicker), due date, meeting link
 *   - Edit modal: same fields as create
 *   - Toggle complete/incomplete with one click
 *   - Delete with confirmation
 *   - Click an item to view detail modal with linked meeting info
 *
 * Data flow:
 *   loadActionItems() → getActionItems(userId) + getCompletedActionItems(userId)
 *   Contacts loaded via getContacts(userId) for the ContactPicker
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { useToast } from "@/components/ui/toast";
import Navigation from "@/components/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getActionItems, updateActionItem, createActionItem, getContacts, getCompletedActionItems, deleteActionItem, replaceContactsForActionItem } from "@/lib/queries";
import { DatePicker } from "@/components/ui/date-picker";
import type { Database } from "@/lib/database.types";
import { CheckSquare, AlertTriangle, Check, Pencil, Calendar, X, Plus, Trash2, RotateCcw, ChevronDown } from "lucide-react";
import { Select } from "@/components/ui/select";

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

  // Detail modal
  const [selectedItem, setSelectedItem] = useState<ActionItem | null>(null);

  // Edit modal
  const [editingItem, setEditingItem] = useState<ActionItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editContactIds, setEditContactIds] = useState<number[]>([]);
  const [editMeetingId, setEditMeetingId] = useState<number | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [allContacts, setAllContacts] = useState<{ id: number; name: string }[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [newContactIds, setNewContactIds] = useState<number[]>([]);
  const [newMeetingId, setNewMeetingId] = useState<number | null>(null);
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

  useEffect(() => { if (user) { loadActionItems(); loadContacts(); } }, [user, loadActionItems, loadContacts]);

  const restoreItem = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      await updateActionItem(id, { is_completed: false, completed_at: null });
      await loadActionItems();
      toastSuccess("Action item restored");
    } catch (err) { toastError("Failed to restore action item"); }
  };

  const removeItem = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    if (!confirm("Permanently delete this action item?")) return;
    try {
      await deleteActionItem(id);
      await loadActionItems();
      if (selectedItem?.id === id) setSelectedItem(null);
      toastSuccess("Action item deleted");
    } catch (err) { toastError("Failed to delete action item"); }
  };

  const markDone = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      const item = actionItems.find((a) => a.id === id);
      const contactId = item?.contacts?.id || item?.action_item_contacts?.[0]?.contact_id;
      const contactName = item?.contacts?.name || item?.action_item_contacts?.[0]?.contacts?.name;

      await updateActionItem(id, { is_completed: true, completed_at: new Date().toISOString() });
      await loadActionItems();
      if (selectedItem?.id === id) setSelectedItem(null);

      const actions: { label: string; onClick: () => void }[] = [];
      if (contactId) {
        actions.push({ label: "Log conversation", onClick: () => openQuickCapture(contactId) });
      }
      toast(`Completed${contactName ? ` · ${contactName}` : ""}`, {
        variant: "success",
        duration: 6000,
        actions: actions.length > 0 ? actions : undefined,
      });
    } catch (err) { toastError("Failed to complete action item"); }
  };

  const openEdit = async (e: React.MouseEvent, item: ActionItem) => {
    e.stopPropagation();
    setEditingItem(item);
    setEditTitle(item.title);
    setEditDescription(item.description || "");
    setEditDueDate(item.due_at ? item.due_at.split("T")[0] : "");
    // Derive contact IDs from junction table, fallback to legacy contact_id
    const ids = item.action_item_contacts?.map(ac => ac.contact_id) ?? (item.contact_id ? [item.contact_id] : []);
    setEditContactIds(ids);
    setEditMeetingId(item.meeting_id);
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
      });
      await replaceContactsForActionItem(editingItem.id, editContactIds);
      await loadActionItems();
      setEditingItem(null);
      if (selectedItem?.id === editingItem.id) setSelectedItem(null);
      toastSuccess("Action item updated");
    } catch (err) { toastError("Failed to update action item"); }
    finally { setEditSaving(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Navigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading action items…</span>
          </div>
        </div>
      </div>
    );
  }

  const overdueItems = actionItems.filter(item =>
    item.due_at && new Date(item.due_at) < new Date()
  );
  const upcomingItems = actionItems.filter(item =>
    !item.due_at || new Date(item.due_at) >= new Date()
  );

  const renderItem = (item: ActionItem, overdue: boolean) => (
    <Card
      key={item.id}
      variant="outlined"
      className={`state-layer cursor-pointer transition-all ${overdue ? "border-destructive/40" : ""}`}
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
            <h3 className="text-base font-medium text-foreground">{item.title}</h3>
            <p className="text-sm text-muted-foreground">
              {(item.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", ")) || item.contacts?.name || "No contact"}
              {item.meetings && <span> · <Calendar className="inline h-3 w-3 mb-0.5" /> {item.meetings.meeting_type}</span>}
            </p>
            {item.description && (
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
            <Button variant={overdue ? "danger" : "tonal"} size="sm" onClick={(e) => markDone(e, item.id)}>
              <Check className="h-4 w-4" /> Done
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen bg-background">
      <Navigation />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
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

        {/* Overdue section */}
        {overdueItems.length > 0 && (
          <div className="mb-10">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <h2 className="text-base font-medium text-destructive">
                Overdue ({overdueItems.length})
              </h2>
            </div>
            <div className="space-y-3">
              {overdueItems.map((item) => renderItem(item, true))}
            </div>
          </div>
        )}

        {/* Upcoming section */}
        <div>
          <h2 className="text-base font-medium text-muted-foreground mb-4">
            Upcoming{upcomingItems.length > 0 ? ` (${upcomingItems.length})` : ""}
          </h2>

          {upcomingItems.length === 0 && overdueItems.length === 0 ? (
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
          ) : upcomingItems.length === 0 ? (
            <Card variant="filled" className="text-center py-10">
              <CardContent>
                <p className="text-sm text-muted-foreground">No upcoming items — just overdue ones above.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {upcomingItems.map((item) => renderItem(item, false))}
            </div>
          )}
        </div>

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
                          <button onClick={(e) => removeItem(e, item.id)} className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer" title="Delete">
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
                  <h2 className="text-[22px] leading-7 font-normal text-foreground">{selectedItem.title}</h2>
                  <p className="text-sm text-muted-foreground mt-1">{(() => { const names = selectedItem.action_item_contacts?.map(ac => ac.contacts?.name).filter(Boolean).join(", "); return names ? `For ${names}` : selectedItem.contacts ? `For ${selectedItem.contacts.name}` : "No contact assigned"; })()}</p>
                </div>
                <button onClick={() => setSelectedItem(null)} className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="px-6 pb-6 space-y-4">
                {/* Details */}
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

                {/* Linked meeting */}
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

                {/* Actions */}
                <div className="flex justify-between pt-2">
                  <Button variant="danger" size="sm" onClick={(e) => { removeItem(e, selectedItem.id); }}>
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
                      <Button onClick={(e) => markDone(e, selectedItem.id)}>
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
            <div className="absolute inset-0 bg-black/32" onClick={() => { setShowCreate(false); setNewTitle(""); setNewDescription(""); setNewDueDate(""); setNewContactIds([]); setNewMeetingId(null); }} />
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
                    placeholder="Follow up about…"
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
                    placeholder="Optional details…"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Due date</label>
                  <DatePicker value={newDueDate} onChange={setNewDueDate} placeholder="No due date" />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="text" onClick={() => { setShowCreate(false); setNewTitle(""); setNewDescription(""); setNewDueDate(""); setNewContactIds([]); setNewMeetingId(null); }}>Cancel</Button>
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
                        }, newContactIds);
                        setShowCreate(false);
                        setNewTitle("");
                        setNewDescription("");
                        setNewDueDate("");
                        setNewContactIds([]);
                        setNewMeetingId(null);
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
                    placeholder="Follow up about…"
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
                    placeholder="Optional details…"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Due date</label>
                  <DatePicker value={editDueDate} onChange={setEditDueDate} placeholder="No due date" />
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
