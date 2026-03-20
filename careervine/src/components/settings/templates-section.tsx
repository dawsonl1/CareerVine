"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { EmailTemplate } from "@/lib/types";
import { Sparkles, Plus, Pencil, Trash2, X } from "lucide-react";
import { inputClasses, labelClasses } from "@/lib/form-styles";

export default function TemplatesSection() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTemplate, setEditingTemplate] = useState<{ id?: number; name: string; prompt: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const loadTemplates = useCallback(async () => {
    try {
      const res = await fetch("/api/gmail/templates");
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const handleSave = async () => {
    if (!editingTemplate) return;
    if (!editingTemplate.name.trim() || !editingTemplate.prompt.trim()) {
      setError("Name and prompt are both required.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/gmail/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingTemplate.id || undefined,
          name: editingTemplate.name.trim(),
          prompt: editingTemplate.prompt.trim(),
          sort_order: templates.length,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setEditingTemplate(null);
      loadTemplates();
    } catch {
      setError("Failed to save template.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this template?")) return;
    try {
      await fetch(`/api/gmail/templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch {
      // ignore
    }
  };

  return (
    <Card variant="outlined">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">AI email templates</h2>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditingTemplate({ name: "", prompt: "" })}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            New template
          </Button>
        </div>

        <p className="text-xs text-muted-foreground mb-4">
          Create custom templates for the &quot;Write with AI&quot; feature in the compose window. Your templates appear alongside the built-in presets.
        </p>

        {/* Template editor */}
        {editingTemplate && (
          <div className="mb-4 p-4 rounded-xl bg-surface-container-low border border-outline-variant">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-foreground">
                {editingTemplate.id ? "Edit template" : "New template"}
              </p>
              <button
                type="button"
                onClick={() => { setEditingTemplate(null); setError(""); }}
                className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelClasses}>Template name</label>
                <input
                  type="text"
                  value={editingTemplate.name}
                  onChange={(e) => setEditingTemplate({ ...editingTemplate, name: e.target.value })}
                  className={inputClasses}
                  placeholder='e.g., "Job referral request"'
                />
              </div>
              <div>
                <label className={labelClasses}>Prompt / instructions for AI</label>
                <textarea
                  value={editingTemplate.prompt}
                  onChange={(e) => setEditingTemplate({ ...editingTemplate, prompt: e.target.value })}
                  className="w-full h-24 px-4 py-3 bg-surface-container-low text-foreground rounded-[4px] border border-outline placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:border-2 transition-colors text-sm resize-none"
                  placeholder='e.g., "Write a professional email requesting a referral for a position at their company."'
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={handleSave} loading={saving}>
                  {editingTemplate.id ? "Save changes" : "Create template"}
                </Button>
                <Button type="button" variant="text" size="sm" onClick={() => { setEditingTemplate(null); setError(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Template list */}
        {loading ? (
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
            <span className="text-sm">Loading templates...</span>
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-6">
            <Sparkles className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No custom templates yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Built-in presets (Introduction, Follow-up, Thank you, etc.) are always available.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {templates.map((t) => (
              <div key={t.id} className="flex items-start gap-3 p-3 rounded-lg border border-outline-variant/50 hover:bg-surface-container-low/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{t.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{t.prompt}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setEditingTemplate({ id: t.id, name: t.name, prompt: t.prompt })}
                    className="p-1.5 rounded-full text-muted-foreground hover:text-primary cursor-pointer transition-colors"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(t.id)}
                    className="p-1.5 rounded-full text-muted-foreground hover:text-destructive cursor-pointer transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
