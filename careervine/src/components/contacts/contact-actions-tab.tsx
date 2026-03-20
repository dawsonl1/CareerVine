"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { ContactPicker } from "@/components/ui/contact-picker";
import { createActionItem, updateActionItem, deleteActionItem, replaceContactsForActionItem, getActionItemsForContact, getCompletedActionItemsForContact } from "@/lib/queries";
import type { Contact, ContactMeeting } from "@/lib/types";
import { Plus, Pencil, Trash2, Check, ChevronDown, CheckSquare } from "lucide-react";

import { inputClasses } from "@/lib/form-styles";

type ActionItem = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  is_completed: boolean;
  meetings: { id: number; meeting_type: string; meeting_date: string } | null;
  action_item_contacts?: { contact_id: number; contacts: { id: number; name: string } | null }[];
};

type CompletedAction = {
  id: number;
  title: string;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  meetings: { id: number; meeting_type: string; meeting_date: string } | null;
};

interface ContactActionsTabProps {
  contactId: number;
  userId: string;
  actions: ActionItem[];
  completedActions: CompletedAction[];
  allContacts: Contact[];
  meetings: ContactMeeting[];
  onActionsChange: (actions: ActionItem[], completed: CompletedAction[]) => void;
}

export function ContactActionsTab({
  contactId,
  userId,
  actions,
  completedActions,
  allContacts,
  meetings,
  onActionsChange,
}: ContactActionsTabProps) {
  const [showCompleted, setShowCompleted] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editDueDate, setEditDueDate] = useState("");
  const [editContactIds, setEditContactIds] = useState<number[]>([]);

  const [showModal, setShowModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newDueDate, setNewDueDate] = useState("");
  const [newMeetingId, setNewMeetingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const reloadActions = async () => {
    try {
      const [acts, completed] = await Promise.all([
        getActionItemsForContact(contactId),
        getCompletedActionItemsForContact(contactId),
      ]);
      onActionsChange(acts as ActionItem[], completed as CompletedAction[]);
    } catch {}
  };

  const now = new Date();
  const oneMonthOut = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const filtered = actions.filter((a) => !a.due_at || new Date(a.due_at) <= oneMonthOut);

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-3">
        <CheckSquare className="h-3.5 w-3.5" /> Pending actions{filtered.length > 0 ? ` (${filtered.length})` : ""}
      </h4>

      {filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">No pending action items due soon.</p>
      ) : (
        <div className="space-y-1.5 mb-3">
          {filtered.map((action) =>
            editingId === action.id ? (
              <div key={action.id} className="p-3 rounded-[8px] bg-surface-container space-y-2">
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className={`${inputClasses} !h-10 text-sm`}
                  placeholder="Title"
                />
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className={`${inputClasses} !h-auto py-2 text-sm`}
                  rows={2}
                  placeholder="Description (optional)"
                />
                <ContactPicker
                  allContacts={allContacts.map((c) => ({ id: c.id, name: c.name }))}
                  selectedIds={editContactIds}
                  onChange={setEditContactIds}
                />
                <DatePicker value={editDueDate} onChange={setEditDueDate} placeholder="No due date" />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="text" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={async () => {
                      try {
                        await updateActionItem(action.id, {
                          title: editTitle.trim(),
                          description: editDescription.trim() || null,
                          due_at: editDueDate || null,
                        });
                        await replaceContactsForActionItem(action.id, editContactIds);
                        await reloadActions();
                        setEditingId(null);
                      } catch (err) {
                        console.error("Error updating action:", err);
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div key={action.id} className="flex items-center gap-2 text-sm group">
                <CheckSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-foreground flex-1 min-w-0 truncate">{action.title}</span>
                {action.due_at && (
                  <span
                    className={`text-xs shrink-0 ${
                      new Date(action.due_at) < new Date() ? "text-destructive font-medium" : "text-muted-foreground"
                    }`}
                  >
                    {new Date(action.due_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(action.id);
                      setEditTitle(action.title);
                      setEditDescription(action.description || "");
                      setEditDueDate(action.due_at ? action.due_at.split("T")[0] : "");
                      setEditContactIds(action.action_item_contacts?.map((ac) => ac.contact_id) || []);
                    }}
                    className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Edit"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await updateActionItem(action.id, { is_completed: true, completed_at: new Date().toISOString() });
                        await reloadActions();
                      } catch {}
                    }}
                    className="p-1 rounded-full text-muted-foreground hover:text-primary cursor-pointer"
                    title="Mark done"
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm("Delete this action item?")) return;
                      try {
                        await deleteActionItem(action.id);
                        await reloadActions();
                      } catch {}
                    }}
                    className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer"
                    title="Delete"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}

      <Button type="button" variant="tonal" size="sm" onClick={() => setShowModal(true)}>
        <Plus className="h-4 w-4" /> Add action item
      </Button>

      {completedActions.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowCompleted(!showCompleted)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            <ChevronDown className={`h-3 w-3 transition-transform ${showCompleted ? "rotate-0" : "-rotate-90"}`} />
            Completed ({completedActions.length})
          </button>
          {showCompleted && (
            <div className="space-y-1.5 mt-2">
              {completedActions.map((action) => (
                <div key={action.id} className="flex items-center gap-2 text-sm">
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="text-muted-foreground line-through">{action.title}</span>
                  {action.completed_at && (
                    <span className="text-xs text-muted-foreground">
                      · {new Date(action.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create action item modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/32"
            onClick={() => {
              setShowModal(false);
              setNewTitle("");
              setNewDescription("");
              setNewDueDate("");
              setNewMeetingId(null);
            }}
          />
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
              {meetings.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Link to meeting</label>
                  <Select
                    value={String(newMeetingId ?? "")}
                    onChange={(val) => setNewMeetingId(val ? Number(val) : null)}
                    placeholder="No linked meeting"
                    options={[
                      { value: "", label: "No linked meeting" },
                      ...meetings.map((m) => ({
                        value: String(m.id),
                        label: `${m.meeting_type.charAt(0).toUpperCase() + m.meeting_type.slice(1)} — ${new Date(m.meeting_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
                      })),
                    ]}
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="text"
                  onClick={() => {
                    setShowModal(false);
                    setNewTitle("");
                    setNewDescription("");
                    setNewDueDate("");
                    setNewMeetingId(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!newTitle.trim() || saving}
                  loading={saving}
                  onClick={async () => {
                    setSaving(true);
                    try {
                      await createActionItem({
                        user_id: userId,
                        contact_id: contactId,
                        meeting_id: newMeetingId,
                        title: newTitle.trim(),
                        description: newDescription.trim() || null,
                        due_at: newDueDate || null,
                        is_completed: false,
                        created_at: new Date().toISOString(),
                        completed_at: null,
                      });
                      setShowModal(false);
                      setNewTitle("");
                      setNewDescription("");
                      setNewDueDate("");
                      setNewMeetingId(null);
                      await reloadActions();
                    } catch (err) {
                      console.error("Error creating action item:", err);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  Create
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
