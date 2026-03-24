/**
 * Interactions page — contact-scoped interaction CRUD
 *
 * NOTE: This component is designed to be embedded inside a contact detail view,
 * not used as a standalone page. It requires contactId and contactName props.
 * Standalone interaction management is handled on the Activity page (/meetings).
 *
 * Features:
 *   - List interactions for a single contact
 *   - Create/edit interaction modal (date, type, summary)
 *   - Delete with confirmation
 *
 * Data flow:
 *   loadInteractions() → getInteractions(contactId)
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getInteractions, createInteraction, updateInteraction, deleteInteraction } from "@/lib/queries";
import type { Database } from "@/lib/database.types";
import { Plus, MessageSquare, Pencil, Trash2 } from "lucide-react";
import { Select } from "@/components/ui/select";

type Interaction = Database["public"]["Tables"]["interactions"]["Row"];

interface InteractionsPageProps {
  contactId?: number;
  contactName?: string;
}

import { inputClasses, labelClasses } from "@/lib/form-styles";

const emptyForm = { interaction_date: "", interaction_type: "", summary: "" };

export default function InteractionsPage({ contactId, contactName }: InteractionsPageProps) {
  const { user } = useAuth();
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(emptyForm);
  const [editingInteraction, setEditingInteraction] = useState<Interaction | null>(null);

  const loadInteractions = useCallback(async () => {
    if (!contactId) return;
    try { setInteractions(await getInteractions(contactId)); }
    catch (e) { console.error("Error loading interactions:", e); }
    finally { setLoading(false); }
  }, [contactId]);

  useEffect(() => { if (contactId) loadInteractions(); }, [contactId, loadInteractions]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactId) return;
    try {
      if (editingInteraction) {
        await updateInteraction(editingInteraction.id, {
          interaction_date: formData.interaction_date,
          interaction_type: formData.interaction_type,
          summary: formData.summary || null,
        });
      } else {
        await createInteraction({
          contact_id: contactId,
          interaction_date: formData.interaction_date,
          interaction_type: formData.interaction_type,
          summary: formData.summary || null,
        });
      }
      await loadInteractions();
      setShowForm(false);
      setFormData(emptyForm);
      setEditingInteraction(null);
    } catch (e) { console.error("Error saving interaction:", e); }
  };

  const handleEditInteraction = (interaction: Interaction) => {
    setEditingInteraction(interaction);
    setFormData({
      interaction_date: interaction.interaction_date,
      interaction_type: interaction.interaction_type,
      summary: interaction.summary || "",
    });
    setShowForm(true);
  };

  const handleDeleteInteraction = async (id: number) => {
    if (!confirm("Delete this interaction?")) return;
    try {
      await deleteInteraction(id);
      await loadInteractions();
    } catch (e) { console.error("Error deleting interaction:", e); }
  };

  if (loading) {
    return (
      <div className="py-8">
        <div className="flex items-center gap-4 text-muted-foreground">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
          <span className="text-base">Loading interactions…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="py-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-[28px] leading-9 font-normal text-foreground">
            Interactions{contactName ? ` — ${contactName}` : ""}
          </h1>
          <p className="text-base text-muted-foreground mt-1">
            Track all your touchpoints with this contact
          </p>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="h-5 w-5" /> Add interaction
        </Button>
      </div>

      {/* Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
          <div className="absolute inset-0 bg-black/32" onClick={() => setShowForm(false)} />
          <div className="relative w-full max-w-lg bg-surface-container-high rounded-[28px] shadow-lg max-h-[90vh] overflow-y-auto">
            <div className="px-7 pt-7 pb-5">
              <h2 className="text-[22px] leading-7 font-normal text-foreground">{editingInteraction ? "Edit interaction" : "New interaction"}</h2>
            </div>
            <form onSubmit={handleSubmit} className="px-7 pb-7 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClasses}>Date & Time *</label>
                  <input type="datetime-local" required value={formData.interaction_date} onChange={(e) => setFormData({ ...formData, interaction_date: e.target.value })} className={inputClasses} />
                </div>
                <div>
                  <label className={labelClasses}>Type *</label>
                  <Select
                    required
                    value={formData.interaction_type}
                    onChange={(val) => setFormData({ ...formData, interaction_type: val })}
                    placeholder="Select…"
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
                <textarea value={formData.summary} onChange={(e) => setFormData({ ...formData, summary: e.target.value })} className={`${inputClasses} !h-auto py-3`} rows={4} placeholder="What was discussed? Key takeaways?" />
              </div>
              <div className="flex justify-end gap-2.5 pt-3">
                <Button type="button" variant="text" onClick={() => { setShowForm(false); setEditingInteraction(null); setFormData(emptyForm); }}>Cancel</Button>
                <Button type="submit">{editingInteraction ? "Save" : "Create"}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Empty state */}
      {interactions.length === 0 ? (
        <Card variant="outlined" className="text-center py-16">
          <CardContent>
            <MessageSquare className="mx-auto h-14 w-14 text-muted-foreground mb-5" />
            <p className="text-lg text-foreground mb-1">No interactions yet</p>
            <p className="text-base text-muted-foreground mb-7">Record your first touchpoint.</p>
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-5 w-5" /> Add interaction
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {interactions.map((interaction) => (
            <Card key={interaction.id} variant="outlined" className="state-layer group">
              <CardContent className="p-6">
                <div className="flex items-start gap-5">
                  <div className="w-12 h-12 rounded-full bg-tertiary-container flex items-center justify-center shrink-0">
                    <MessageSquare className="h-6 w-6 text-on-tertiary-container" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-medium text-foreground capitalize">{interaction.interaction_type}</h3>
                      <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button type="button" onClick={() => handleEditInteraction(interaction)} className="p-2 rounded-full text-muted-foreground hover:text-foreground cursor-pointer transition-colors" title="Edit">
                          <Pencil className="h-5 w-5" />
                        </button>
                        <button type="button" onClick={() => handleDeleteInteraction(interaction.id)} className="p-2 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors" title="Delete">
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-base text-muted-foreground">
                      {new Date(interaction.interaction_date).toLocaleString()}
                    </p>
                    {interaction.summary && (
                      <p className="mt-4 text-base text-muted-foreground whitespace-pre-wrap">
                        {interaction.summary}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
