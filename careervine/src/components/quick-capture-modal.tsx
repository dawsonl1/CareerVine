"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/components/auth-provider";
import { useQuickCapture } from "@/components/quick-capture-context";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { ContactPicker } from "@/components/ui/contact-picker";
import { DatePicker } from "@/components/ui/date-picker";
import { getContacts, createInteraction, createActionItem } from "@/lib/queries";
import {
  X,
  Coffee,
  Phone,
  Video,
  Users,
  Calendar,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";
import { inputClasses } from "@/lib/form-styles";

const INTERACTION_TYPES = [
  { value: "coffee", label: "Coffee", icon: Coffee },
  { value: "phone", label: "Phone", icon: Phone },
  { value: "video", label: "Video", icon: Video },
  { value: "in_person", label: "In person", icon: Users },
  { value: "event", label: "Event", icon: Calendar },
  { value: "other", label: "Other", icon: MessageSquare },
] as const;

type PendingAction = {
  title: string;
  dueAt: string;
};

export function QuickCaptureModal() {
  const { user } = useAuth();
  const { isOpen, prefillContactId, close } = useQuickCapture();
  const { success: toastSuccess, error: toastError } = useToast();

  const [allContacts, setAllContacts] = useState<{ id: number; name: string }[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<number[]>([]);
  const [interactionType, setInteractionType] = useState<typeof INTERACTION_TYPES[number]["value"]>("coffee");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [newActionTitle, setNewActionTitle] = useState("");
  const [newActionDue, setNewActionDue] = useState("");
  const [saving, setSaving] = useState(false);

  // Load contacts list only when modal is opened
  useEffect(() => {
    if (user && isOpen) {
      getContacts(user.id)
        .then((data) => setAllContacts(data.map((c: any) => ({ id: c.id, name: c.name }))))
        .catch(() => {});
    }
  }, [user, isOpen]);

  // Reset form when opened
  useEffect(() => {
    if (isOpen) {
      setSelectedContactIds(prefillContactId ? [prefillContactId] : []);
      setInteractionType("coffee");
      setDate(new Date().toISOString().split("T")[0]);
      setNotes("");
      setPendingActions([]);
      setNewActionTitle("");
      setNewActionDue("");
    }
  }, [isOpen, prefillContactId]);

  const addAction = useCallback(() => {
    if (!newActionTitle.trim()) return;
    setPendingActions((prev) => [...prev, { title: newActionTitle.trim(), dueAt: newActionDue }]);
    setNewActionTitle("");
    setNewActionDue("");
  }, [newActionTitle, newActionDue]);

  const removeAction = (index: number) => {
    setPendingActions((prev) => prev.filter((_, i) => i !== index));
  };

  const savingRef = useRef(false);

  const handleSave = async () => {
    if (savingRef.current || !user || selectedContactIds.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // Create interactions for all selected contacts in parallel
      const interactionDate = date || new Date().toISOString().split("T")[0];
      const interactionResults = await Promise.allSettled(
        selectedContactIds.map((contactId) =>
          createInteraction({
            contact_id: contactId,
            interaction_date: interactionDate,
            interaction_type: interactionType,
            summary: notes || null,
          })
        )
      );

      const failedInteractions = interactionResults.filter((r) => r.status === "rejected");
      if (failedInteractions.length === interactionResults.length) {
        throw new Error("All interactions failed");
      }

      // Create action items in parallel
      if (pendingActions.length > 0) {
        const now = new Date().toISOString();
        await Promise.allSettled(
          pendingActions.map((action) =>
            createActionItem(
              {
                user_id: user.id,
                contact_id: selectedContactIds[0],
                title: action.title,
                description: null,
                due_at: action.dueAt || null,
                is_completed: false,
                meeting_id: null,
                created_at: now,
                completed_at: null,
              },
              selectedContactIds
            )
          )
        );
      }

      const contactName = allContacts.find((c) => c.id === selectedContactIds[0])?.name || "contact";
      if (failedInteractions.length > 0) {
        toastSuccess(`Conversation logged (${failedInteractions.length} contact${failedInteractions.length > 1 ? "s" : ""} failed)`);
      } else {
        toastSuccess(`Conversation with ${contactName} logged`);
      }
      close();

      // Notify other components to refresh
      window.dispatchEvent(new CustomEvent("careervine:conversation-logged"));
    } catch (err) {
      console.error("Error saving conversation:", err);
      toastError("Failed to save conversation");
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={close} />

      {/* Modal */}
      <div className="relative w-full sm:max-w-lg max-h-[100dvh] sm:max-h-[85vh] bg-background rounded-t-[28px] sm:rounded-[28px] shadow-xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-background z-10 flex items-center justify-between px-6 pt-6 pb-4 border-b border-outline-variant">
          <h2 className="text-lg font-medium text-foreground">Log a conversation</h2>
          <button
            onClick={close}
            className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Contact picker */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Who did you talk to?
            </label>
            <ContactPicker
              allContacts={allContacts}
              selectedIds={selectedContactIds}
              onChange={setSelectedContactIds}
              placeholder="Search contacts…"
            />
          </div>

          {/* Interaction type chips */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Type
            </label>
            <div className="flex flex-wrap gap-2">
              {INTERACTION_TYPES.map((type) => {
                const Icon = type.icon;
                const active = interactionType === type.value;
                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setInteractionType(type.value)}
                    className={`inline-flex items-center gap-1.5 h-9 px-4 rounded-full text-sm font-medium cursor-pointer transition-colors ${
                      active
                        ? "bg-secondary-container text-on-secondary-container"
                        : "bg-surface-container text-foreground hover:bg-surface-container-high"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {type.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Date */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              When
            </label>
            <DatePicker value={date} onChange={setDate} />
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`${inputClasses} !h-auto py-3`}
              rows={3}
              placeholder="What did you discuss?"
            />
          </div>

          {/* Action items section */}
          <div className="border-t border-outline-variant pt-5">
            <label className="text-xs font-medium text-muted-foreground mb-2 block">
              Any follow-ups?
            </label>

            {/* Existing pending actions */}
            {pendingActions.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {pendingActions.map((action, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 rounded-[8px] bg-surface-container-low">
                    <span className="text-sm text-foreground flex-1 truncate">{action.title}</span>
                    {action.dueAt && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        Due {new Date(action.dueAt + "T00:00:00").toLocaleDateString()}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeAction(i)}
                      className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer shrink-0"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add action item inline */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newActionTitle}
                onChange={(e) => setNewActionTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addAction();
                  }
                }}
                className={`${inputClasses} flex-1`}
                placeholder="Action item title"
              />
              <div className="w-[140px] shrink-0">
                <DatePicker value={newActionDue} onChange={setNewActionDue} placeholder="Due date" />
              </div>
              <Button
                type="button"
                variant="tonal"
                size="sm"
                onClick={addAction}
                disabled={!newActionTitle.trim()}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-background border-t border-outline-variant px-6 py-4 flex justify-end gap-2">
          <Button variant="text" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={selectedContactIds.length === 0}
          >
            Save conversation
          </Button>
        </div>
      </div>
    </div>
  );
}
