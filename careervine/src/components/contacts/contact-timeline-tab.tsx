"use client";

import { useState } from "react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { updateInteraction, deleteInteraction, getInteractions } from "@/lib/queries";
import type { ContactMeeting, InteractionRow, EmailMessage, CompletedActionEntry, TimelineEntry } from "@/lib/types";
import { Calendar, MessageSquare, Pencil, Trash2, ArrowUpRight, ArrowDownLeft, CheckCircle } from "lucide-react";

import { inputClasses, labelClasses } from "@/lib/form-styles";

interface ContactTimelineTabProps {
  contactId: number;
  meetings: ContactMeeting[];
  interactions: InteractionRow[];
  emails: EmailMessage[];
  completedActions: CompletedActionEntry[];
  loading: boolean;
  onMeetingClick?: (meeting: ContactMeeting) => void;
  onInteractionsChange: (interactions: InteractionRow[]) => void;
}

export function ContactTimelineTab({
  contactId,
  meetings,
  interactions,
  emails,
  completedActions,
  loading,
  onMeetingClick,
  onInteractionsChange,
}: ContactTimelineTabProps) {
  const [editingInteraction, setEditingInteraction] = useState<InteractionRow | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [interactionForm, setInteractionForm] = useState({ interaction_date: "", interaction_type: "", summary: "" });

  const entries: TimelineEntry[] = [
    ...meetings.map((m) => ({ kind: "meeting" as const, date: m.meeting_date, data: m })),
    ...interactions.map((i) => ({ kind: "interaction" as const, date: i.interaction_date, data: i })),
    ...emails.map((e) => ({ kind: "email" as const, date: e.date || "", data: e })),
    ...completedActions
      .filter((a) => a.completed_at)
      .map((a) => ({ kind: "completed_action" as const, date: a.completed_at!, data: a })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const handleDeleteInteraction = async (id: number) => {
    if (!confirm("Delete this interaction?")) return;
    try {
      await deleteInteraction(id);
      onInteractionsChange(interactions.filter((x) => x.id !== id));
    } catch {}
  };

  const handleSaveInteraction = async () => {
    if (!editingInteraction) return;
    try {
      await updateInteraction(editingInteraction.id, {
        interaction_date: interactionForm.interaction_date,
        interaction_type: interactionForm.interaction_type,
        summary: interactionForm.summary || null,
      });
      const updated = await getInteractions(contactId);
      onInteractionsChange(updated);
      setShowEditModal(false);
      setEditingInteraction(null);
    } catch (err) {
      console.error("Error saving interaction:", err);
    }
  };

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-3">
        <Calendar className="h-3.5 w-3.5" /> Timeline{entries.length > 0 ? ` (${entries.length})` : ""}
      </h4>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-2">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
          <span className="text-xs">Loading...</span>
        </div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground py-1">
          No interactions yet. Use &quot;Log conversation&quot; above to record your first interaction.
        </p>
      ) : (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-[15px] top-4 bottom-4 w-px bg-outline-variant/50" />

          <div className="space-y-2">
            {entries.map((item, idx) => {
              if (item.kind === "meeting") {
                const m = item.data;
                return (
                  <div
                    key={`m-${m.id}`}
                    className="relative flex items-start gap-3 p-3 rounded-[12px] hover:bg-surface-container-low transition-colors cursor-pointer"
                    onClick={() => onMeetingClick?.(m)}
                  >
                    <div className="w-8 h-8 rounded-full bg-secondary-container flex items-center justify-center shrink-0 z-10">
                      <Calendar className="h-3.5 w-3.5 text-on-secondary-container" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground capitalize">{m.meeting_type}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                      {m.notes && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{m.notes}</p>}
                    </div>
                  </div>
                );
              }
              if (item.kind === "interaction") {
                const i = item.data;
                return (
                  <div key={`i-${i.id}`} className="relative flex items-center gap-3 p-3 rounded-[12px] hover:bg-surface-container-low transition-colors group">
                    <div className="w-8 h-8 rounded-full bg-tertiary-container flex items-center justify-center shrink-0 z-10">
                      <MessageSquare className="h-3.5 w-3.5 text-on-tertiary-container" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground capitalize">{i.interaction_type}</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                      {i.summary && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{i.summary}</p>}
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingInteraction(i);
                          setInteractionForm({
                            interaction_date: i.interaction_date,
                            interaction_type: i.interaction_type,
                            summary: i.summary || "",
                          });
                          setShowEditModal(true);
                        }}
                        className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteInteraction(i.id);
                        }}
                        className="p-1 rounded-full text-muted-foreground hover:text-destructive cursor-pointer"
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              }
              if (item.kind === "completed_action") {
                const a = item.data;
                return (
                  <div key={`ca-${a.id}`} className="relative flex items-center gap-3 p-3 rounded-[12px] hover:bg-surface-container-low transition-colors">
                    <div className="w-8 h-8 rounded-full bg-primary/15 flex items-center justify-center shrink-0 z-10">
                      <CheckCircle className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">Action completed</span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{a.title}</p>
                    </div>
                  </div>
                );
              }
              // email
              const e = item.data;
              return (
                <div key={`e-${e.gmail_message_id}`} className="relative flex items-center gap-3 p-3 rounded-[12px] hover:bg-surface-container-low transition-colors">
                  <div className="w-8 h-8 rounded-full bg-primary-container flex items-center justify-center shrink-0 z-10">
                    {e.direction === "outbound" ? (
                      <ArrowUpRight className="h-3.5 w-3.5 text-on-primary-container" />
                    ) : (
                      <ArrowDownLeft className="h-3.5 w-3.5 text-on-primary-container" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">{e.subject || "(no subject)"}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {e.date ? new Date(e.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{e.snippet || ""}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Interaction edit modal */}
      {showEditModal && editingInteraction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/32" onClick={() => setShowEditModal(false)} />
          <div className="relative w-full max-w-lg bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 pt-6 pb-4">
              <h2 className="text-[22px] leading-7 font-normal text-foreground">
                Edit interaction
              </h2>
            </div>
            <div className="px-6 pb-6 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClasses}>Date & Time *</label>
                  <input
                    type="datetime-local"
                    required
                    value={interactionForm.interaction_date}
                    onChange={(e) => setInteractionForm({ ...interactionForm, interaction_date: e.target.value })}
                    className={inputClasses}
                  />
                </div>
                <div>
                  <label className={labelClasses}>Type *</label>
                  <Select
                    value={interactionForm.interaction_type}
                    onChange={(val) => setInteractionForm({ ...interactionForm, interaction_type: val })}
                    placeholder="Select..."
                    options={[
                      { value: "email", label: "Email" },
                      { value: "phone", label: "Phone Call" },
                      { value: "video", label: "Video Call" },
                      { value: "coffee", label: "Coffee Chat" },
                      { value: "lunch", label: "Lunch/Dinner" },
                      { value: "conference", label: "Conference" },
                      { value: "social", label: "Social Media" },
                      { value: "other", label: "Other" },
                    ]}
                  />
                </div>
              </div>
              <div>
                <label className={labelClasses}>Summary</label>
                <textarea
                  value={interactionForm.summary}
                  onChange={(e) => setInteractionForm({ ...interactionForm, summary: e.target.value })}
                  className={`${inputClasses} !h-auto py-3`}
                  rows={4}
                  placeholder="What was discussed? Key takeaways?"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="text" onClick={() => setShowEditModal(false)}>Cancel</Button>
                <Button
                  type="button"
                  disabled={!interactionForm.interaction_date || !interactionForm.interaction_type}
                  onClick={handleSaveInteraction}
                >
                  Save
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
