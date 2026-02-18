"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Sparkles, ChevronDown, X, Loader2, MessageSquare, Calendar, Check } from "lucide-react";

type PresetTemplate = {
  name: string;
  prompt: string;
  sort_order: number;
};

type UserTemplate = PresetTemplate & {
  id: number;
  user_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

type Meeting = {
  id: number;
  meeting_date: string;
  meeting_type: string;
  notes: string | null;
  transcript: string | null;
  contacts?: string;
};

type Props = {
  recipientEmail: string;
  recipientName: string;
  existingSubject: string;
  onGenerated: (body: string, subject?: string | null) => void;
};

export function AiWriteDropdown({ recipientEmail, recipientName, existingSubject, onGenerated }: Props) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<PresetTemplate[]>([]);
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  // Custom prompt mode
  const [showCustomPrompt, setShowCustomPrompt] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  // Meeting selection
  const [showMeetingPicker, setShowMeetingPicker] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedMeetingIds, setSelectedMeetingIds] = useState<number[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(false);
  const [contactId, setContactId] = useState<number | null>(null);

  // Pending template (selected but waiting for optional meeting selection)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load templates on first open
  useEffect(() => {
    if (!open) return;
    fetch("/api/gmail/templates")
      .then((r) => r.json())
      .then((d) => {
        setPresets(d.presets || []);
        setUserTemplates(d.templates || []);
      })
      .catch(() => {});
  }, [open]);

  // Resolve contact ID from recipient email and load their meetings
  const resolveContact = useCallback(async () => {
    if (!recipientEmail.trim()) return;
    try {
      const res = await fetch(`/api/gmail/ai-write/resolve-contact?email=${encodeURIComponent(recipientEmail.trim())}`);
      const data = await res.json();
      if (data.contactId) {
        setContactId(data.contactId);
        setMeetingsLoading(true);
        const mRes = await fetch(`/api/gmail/ai-write/meetings?contactId=${data.contactId}`);
        const mData = await mRes.json();
        setMeetings(mData.meetings || []);
        setMeetingsLoading(false);
      }
    } catch {
      // silent
    }
  }, [recipientEmail]);

  useEffect(() => {
    if (open && recipientEmail) resolveContact();
  }, [open, recipientEmail, resolveContact]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        resetState();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const resetState = () => {
    setShowCustomPrompt(false);
    setCustomPrompt("");
    setShowMeetingPicker(false);
    setSelectedMeetingIds([]);
    setPendingPrompt(null);
    setError("");
  };

  const handleGenerate = async (prompt: string) => {
    setError("");
    setGenerating(true);
    try {
      const res = await fetch("/api/gmail/ai-write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          contactId: contactId || undefined,
          meetingIds: selectedMeetingIds.length > 0 ? selectedMeetingIds : undefined,
          subject: existingSubject || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onGenerated(data.bodyHtml, data.subject);
      setOpen(false);
      resetState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate email");
    } finally {
      setGenerating(false);
    }
  };

  const handleTemplateClick = (prompt: string) => {
    if (meetings.length > 0) {
      // Show meeting picker before generating
      setPendingPrompt(prompt);
      setShowMeetingPicker(true);
    } else {
      handleGenerate(prompt);
    }
  };

  const handleMeetingConfirm = () => {
    if (pendingPrompt) {
      handleGenerate(pendingPrompt);
    }
    setShowMeetingPicker(false);
  };

  const toggleMeeting = (id: number) => {
    setSelectedMeetingIds((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  };

  const allTemplates = [
    ...presets.map((p) => ({ ...p, isUser: false })),
    ...userTemplates.map((t) => ({ name: t.name, prompt: t.prompt, sort_order: t.sort_order, isUser: true })),
  ].sort((a, b) => a.sort_order - b.sort_order);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => { setOpen(!open); if (open) resetState(); }}
        disabled={generating}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer border ${
          generating
            ? "bg-primary-container text-on-primary-container border-primary/30"
            : open
            ? "bg-primary-container text-on-primary-container border-primary/30"
            : "text-muted-foreground border-outline-variant hover:text-foreground hover:border-primary/50"
        }`}
      >
        {generating ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {generating ? "Writing…" : "Write with AI"}
        {!generating && <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>

      {open && !generating && (
        <div className="absolute left-0 bottom-10 z-50 w-80 bg-surface-container-high rounded-xl shadow-lg border border-outline-variant overflow-hidden">
          {/* ── Meeting picker view ── */}
          {showMeetingPicker ? (
            <div>
              <div className="px-3 py-2.5 border-b border-outline-variant/50">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-foreground">Include meeting notes?</p>
                  <button
                    type="button"
                    onClick={() => { setShowMeetingPicker(false); setPendingPrompt(null); }}
                    className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Select meetings to give the AI more context. You can skip this.
                </p>
              </div>

              {meetingsLoading ? (
                <div className="px-3 py-4 flex items-center gap-2 text-muted-foreground text-xs">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading meetings…
                </div>
              ) : meetings.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground">No meetings found with this contact.</div>
              ) : (
                <div className="max-h-48 overflow-y-auto py-1">
                  {meetings.map((m) => {
                    const isSelected = selectedMeetingIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleMeeting(m.id)}
                        className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors cursor-pointer ${
                          isSelected ? "bg-primary/[0.06]" : "hover:bg-surface-container-low"
                        }`}
                      >
                        <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          isSelected ? "bg-primary border-primary" : "border-outline-variant"
                        }`}>
                          {isSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground">
                            {new Date(m.meeting_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            <span className="ml-1.5 font-normal text-muted-foreground">({m.meeting_type})</span>
                          </p>
                          {m.notes && (
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{m.notes.substring(0, 80)}</p>
                          )}
                          {m.transcript && !m.notes && (
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">Has transcript</p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="px-3 py-2.5 border-t border-outline-variant/50 flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleMeetingConfirm}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={handleMeetingConfirm}
                  disabled={selectedMeetingIds.length === 0}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                    selectedMeetingIds.length > 0
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-container-low text-muted-foreground"
                  }`}
                >
                  {selectedMeetingIds.length > 0
                    ? `Include ${selectedMeetingIds.length} meeting${selectedMeetingIds.length > 1 ? "s" : ""}`
                    : "Select meetings"}
                </button>
              </div>
            </div>
          ) : showCustomPrompt ? (
            /* ── Custom prompt view ── */
            <div>
              <div className="px-3 py-2.5 border-b border-outline-variant/50">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-foreground">Custom prompt</p>
                  <button
                    type="button"
                    onClick={() => setShowCustomPrompt(false)}
                    className="p-1 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="p-3">
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Describe the email you want to write…&#10;&#10;e.g., &quot;Write a warm email asking about their new role at Google and suggest catching up over coffee&quot;"
                  className="w-full h-24 px-3 py-2 text-xs bg-surface-container-low text-foreground rounded-lg border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary resize-none"
                  autoFocus
                />
                {meetings.length > 0 && selectedMeetingIds.length > 0 && (
                  <p className="text-[11px] text-primary mt-1.5 flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {selectedMeetingIds.length} meeting{selectedMeetingIds.length > 1 ? "s" : ""} included
                  </p>
                )}
              </div>

              {error && <p className="text-xs text-destructive px-3 pb-2">{error}</p>}

              <div className="px-3 pb-3 flex items-center justify-between">
                {meetings.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => { setPendingPrompt(null); setShowMeetingPicker(true); setShowCustomPrompt(false); }}
                    className="text-[11px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors flex items-center gap-1"
                  >
                    <Calendar className="h-3 w-3" />
                    {selectedMeetingIds.length > 0 ? "Change meetings" : "Add meeting notes"}
                  </button>
                ) : <span />}
                <button
                  type="button"
                  onClick={() => {
                    if (!customPrompt.trim()) return;
                    if (meetings.length > 0 && selectedMeetingIds.length === 0 && !pendingPrompt) {
                      setPendingPrompt(customPrompt.trim());
                      setShowCustomPrompt(false);
                      setShowMeetingPicker(true);
                    } else {
                      handleGenerate(customPrompt.trim());
                    }
                  }}
                  disabled={!customPrompt.trim()}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                    customPrompt.trim()
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-container-low text-muted-foreground"
                  }`}
                >
                  <span className="flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Generate
                  </span>
                </button>
              </div>
            </div>
          ) : (
            /* ── Template list view ── */
            <div>
              <div className="px-3 py-2.5 border-b border-outline-variant/50">
                <p className="text-xs font-medium text-foreground">Choose an email type</p>
                {recipientName && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Writing to <span className="font-medium text-foreground">{recipientName}</span>
                    {contactId && " — contact info will be used for personalization"}
                  </p>
                )}
              </div>

              {error && <p className="text-xs text-destructive px-3 pt-2">{error}</p>}

              <div className="max-h-64 overflow-y-auto py-1">
                {allTemplates.map((t, i) => (
                  <button
                    key={`${t.isUser ? "u" : "p"}-${i}`}
                    type="button"
                    onClick={() => handleTemplateClick(t.prompt)}
                    className="w-full text-left px-3 py-2.5 flex items-start gap-2.5 hover:bg-surface-container-low transition-colors cursor-pointer"
                  >
                    <MessageSquare className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground">{t.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">{t.prompt.substring(0, 80)}</p>
                    </div>
                    {t.isUser && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary-container/50 text-on-primary-container shrink-0">Custom</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Custom prompt option */}
              <div className="border-t border-outline-variant/50">
                <button
                  type="button"
                  onClick={() => setShowCustomPrompt(true)}
                  className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-surface-container-low transition-colors cursor-pointer"
                >
                  <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-primary">Write your own prompt</p>
                    <p className="text-[11px] text-muted-foreground">Describe exactly what you want</p>
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
