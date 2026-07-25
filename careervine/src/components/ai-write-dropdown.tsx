"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useClickOutside } from "@/hooks/use-click-outside";
import { Sparkles, ChevronDown, X, Loader2, MessageSquare, Calendar, Check } from "lucide-react";
import { parseAiFailure, type AiFailureCode } from "@/lib/ai-errors";
import { apiFetch, isApiRequestError, jsonBody } from "@/lib/api-client";
import { AiUnavailableNotice } from "@/components/ai/ai-unavailable-notice";
import { useLatestRequest } from "@/hooks/use-latest-request";

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
  meeting_type: string | null;
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
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const resolveReq = useLatestRequest();
  const [templatesReloadKey, setTemplatesReloadKey] = useState(0);
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [aiFailure, setAiFailure] = useState<AiFailureCode | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");

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
    // `.catch(() => {})` over an unchecked read rendered an empty dropdown with
    // no message, no retry and no explanation, and because `d.presets` was read
    // straight off whatever came back, a `{ error }` body produced the same
    // empty list as a genuine empty result (CAR-188). The built-in presets are
    // server-side constants, so an empty list here is ALWAYS a failure.
    setTemplatesFailed(false);
    apiFetch<{ presets?: PresetTemplate[]; templates?: UserTemplate[] }>("/api/gmail/templates")
      .then((d) => {
        setPresets(d.presets || []);
        setUserTemplates(d.templates || []);
      })
      .catch(() => setTemplatesFailed(true));
  }, [open, templatesReloadKey]);

  // Resolve contact ID from recipient email and load their meetings
  const resolveContact = useCallback(async () => {
    if (!recipientEmail.trim()) return;
    // Identity-keyed read (CONVENTIONS.md §f): the recipient can change while a
    // resolve is in flight, and a slower earlier response must not repopulate
    // the picker for a contact the user has moved off.
    const token = resolveReq.begin();
    try {
      const data = await apiFetch<{ contactId?: number | null }>(
        `/api/gmail/ai-write/resolve-contact?email=${encodeURIComponent(recipientEmail.trim())}`,
      );
      if (!resolveReq.isLatest(token)) return;

      // A null contactId means the recipient is not in the CRM. The route
      // answers 200 for that, so the old `if (data.contactId)` skipped the whole
      // block and left BOTH contactId and meetings pinned to the PREVIOUS
      // recipient — no failure required, and the generated email then carried a
      // different contact's dossier and meeting transcripts (CAR-204).
      if (data.contactId == null) {
        setContactId(null);
        setMeetings([]);
        return;
      }

      setContactId(data.contactId);
      setMeetingsLoading(true);
      const mData = await apiFetch<{ meetings?: Meeting[] }>(
        `/api/gmail/ai-write/meetings?contactId=${data.contactId}`,
      );
      if (!resolveReq.isLatest(token)) return;
      setMeetings(mData.meetings || []);
      setMeetingsLoading(false);
    } catch {
      // error-tolerated: this resolves optional meeting context for the prompt.
      // Failing it means the picker offers no meetings, which is the same as a
      // contact having none, and generation works either way.
      //
      // `setMeetings([])` is load-bearing (CAR-204): the pre-CAR-188 code called
      // `setMeetings(mData.meetings || [])` unconditionally, so an error body
      // cleared the list as a side effect. apiFetch throwing skipped that, and
      // the previous recipient's meetings stayed selectable against the new
      // contactId. The server does not scope meetingIds by contact, so a
      // selection would have put their notes into someone else's email.
      if (!resolveReq.isLatest(token)) return;
      setMeetings([]);
      setMeetingsLoading(false);
    }
  }, [recipientEmail, resolveReq]);

  useEffect(() => {
    // resolveContact swallows its own failures (the picker just shows no
    // meetings), so the effect fires it without awaiting.
    if (open && recipientEmail) void resolveContact();
  }, [open, recipientEmail, resolveContact]);

  const resetState = () => {
    setShowCustomPrompt(false);
    setCustomPrompt("");
    setShowMeetingPicker(false);
    setSelectedMeetingIds([]);
    setPendingPrompt(null);
    setError("");
    setAiFailure(null);
  };

  // Close on outside click
  useClickOutside(dropdownRef, useCallback(() => { setOpen(false); resetState(); }, []), open);

  // reentry-safe: /api/gmail/ai-write reads context and drafts; its only writes are idempotent entitlement upserts
  const handleGenerate = async (prompt: string) => {
    setError("");
    setAiFailure(null);
    setLastPrompt(prompt);
    setGenerating(true);
    try {
      const data = await apiFetch<{ bodyHtml: string; subject?: string }>(
        "/api/gmail/ai-write",
        jsonBody({
          prompt,
          contactId: contactId || undefined,
          meetingIds: selectedMeetingIds.length > 0 ? selectedMeetingIds : undefined,
          subject: existingSubject || undefined,
        }),
      );
      onGenerated(data.bodyHtml, data.subject);
      setOpen(false);
      resetState();
    } catch (err) {
      // ApiRequestError carries the status and parsed body parseAiFailure used
      // to read off the raw Response, so the AI-unavailable branch survives the
      // move into catch unchanged.
      if (isApiRequestError(err)) {
        const code = parseAiFailure(err.status, err.body);
        if (code) {
          setAiFailure(code);
          return;
        }
      }
      setError(isApiRequestError(err) ? err.message : "Failed to generate email");
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
      // handleGenerate reports failures through `error` / `aiFailure`.
      void handleGenerate(prompt);
    }
  };

  const handleMeetingConfirm = () => {
    if (pendingPrompt) {
      void handleGenerate(pendingPrompt);
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
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer border ${
          generating
            ? "bg-primary-container text-on-primary-container border-primary/30"
            : open
            ? "bg-primary-container text-on-primary-container border-primary/30"
            : "text-muted-foreground border-outline-variant hover:text-foreground hover:border-primary/50"
        }`}
      >
        {generating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {generating ? "Writing…" : "Write with AI"}
        {!generating && <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />}
      </button>

      {open && !generating && (
        <div className="absolute left-0 top-11 z-50 w-[22rem] bg-surface-container-high rounded-xl shadow-lg border border-outline-variant overflow-hidden">
          {/* ── Meeting picker view ── */}
          {showMeetingPicker ? (
            <div>
              <div className="px-4 py-3 border-b border-outline-variant/50">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground">Include meeting notes?</p>
                  <button
                    type="button"
                    onClick={() => { setShowMeetingPicker(false); setPendingPrompt(null); }}
                    className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Select meetings to give the AI more context. You can skip this.
                </p>
              </div>

              {meetingsLoading ? (
                <div className="px-4 py-5 flex items-center gap-2.5 text-muted-foreground text-sm">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading meetings…
                </div>
              ) : meetings.length === 0 ? (
                <div className="px-4 py-5 text-sm text-muted-foreground">No meetings found with this contact.</div>
              ) : (
                <div className="max-h-52 overflow-y-auto py-1">
                  {meetings.map((m) => {
                    const isSelected = selectedMeetingIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleMeeting(m.id)}
                        className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors cursor-pointer ${
                          isSelected ? "bg-primary/[0.06]" : "hover:bg-surface-container-low"
                        }`}
                      >
                        <div className={`mt-0.5 w-4.5 h-4.5 rounded border flex items-center justify-center shrink-0 ${
                          isSelected ? "bg-primary border-primary" : "border-outline-variant"
                        }`}>
                          {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            {new Date(m.meeting_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            <span className="ml-2 font-normal text-muted-foreground">({m.meeting_type || "Meeting"})</span>
                          </p>
                          {m.notes && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">{m.notes.substring(0, 80)}</p>
                          )}
                          {m.transcript && !m.notes && (
                            <p className="text-xs text-muted-foreground truncate mt-0.5">Has transcript</p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="px-4 py-3 border-t border-outline-variant/50 flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleMeetingConfirm}
                  className="text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                >
                  Skip
                </button>
                <button
                  type="button"
                  onClick={handleMeetingConfirm}
                  disabled={selectedMeetingIds.length === 0}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
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
              <div className="px-4 py-3 border-b border-outline-variant/50">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-foreground">Custom prompt</p>
                  <button
                    type="button"
                    onClick={() => setShowCustomPrompt(false)}
                    className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="p-4">
                <textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="Describe the email you want to write…&#10;&#10;e.g., &quot;Write a warm email asking about their new role at Google and suggest catching up over coffee&quot;"
                  className="w-full h-28 px-4 py-2.5 text-sm bg-surface-container-low text-foreground rounded-lg border border-outline-variant placeholder:text-muted-foreground focus:outline-none focus:border-primary resize-none"
                  autoFocus
                />
                {meetings.length > 0 && selectedMeetingIds.length > 0 && (
                  <p className="text-xs text-primary mt-2 flex items-center gap-1.5">
                    <Calendar className="h-3.5 w-3.5" />
                    {selectedMeetingIds.length} meeting{selectedMeetingIds.length > 1 ? "s" : ""} included
                  </p>
                )}
              </div>

              {aiFailure ? (
                <div className="px-4 pb-2.5">
                  <AiUnavailableNotice compact code={aiFailure} onRetry={() => handleGenerate(lastPrompt)} />
                </div>
              ) : (
                error && <p className="text-sm text-destructive px-4 pb-2.5">{error}</p>
              )}

              <div className="px-4 pb-4 flex items-center justify-between">
                {meetings.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => { setPendingPrompt(null); setShowMeetingPicker(true); setShowCustomPrompt(false); }}
                    className="text-xs text-muted-foreground hover:text-foreground cursor-pointer transition-colors flex items-center gap-1.5"
                  >
                    <Calendar className="h-3.5 w-3.5" />
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
                      void handleGenerate(customPrompt.trim());
                    }
                  }}
                  disabled={!customPrompt.trim()}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                    customPrompt.trim()
                      ? "bg-primary text-primary-foreground"
                      : "bg-surface-container-low text-muted-foreground"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" /> Generate
                  </span>
                </button>
              </div>
            </div>
          ) : (
            /* ── Template list view ── */
            <div>
              <div className="px-4 py-3 border-b border-outline-variant/50">
                <p className="text-sm font-medium text-foreground">Choose an email type</p>
                {recipientName && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Writing to <span className="font-medium text-foreground">{recipientName}</span>
                    {contactId && " (contact info will be used for personalization)"}
                  </p>
                )}
              </div>

              {aiFailure ? (
                <div className="px-4 pt-2.5">
                  <AiUnavailableNotice compact code={aiFailure} onRetry={() => handleGenerate(lastPrompt)} />
                </div>
              ) : (
                error && <p className="text-sm text-destructive px-4 pt-2.5">{error}</p>
              )}

              {templatesFailed && allTemplates.length === 0 && (
                <div className="px-4 py-6 text-center">
                  <p role="alert" className="text-sm text-foreground">Couldn&apos;t load your templates.</p>
                  <button
                    type="button"
                    onClick={() => setTemplatesReloadKey((k) => k + 1)}
                    className="text-sm text-primary hover:underline cursor-pointer mt-1"
                  >
                    Try again
                  </button>
                </div>
              )}

              <div className="max-h-72 overflow-y-auto py-1">
                {allTemplates.map((t, i) => (
                  <button
                    key={`${t.isUser ? "u" : "p"}-${i}`}
                    type="button"
                    onClick={() => handleTemplateClick(t.prompt)}
                    className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors cursor-pointer"
                  >
                    <MessageSquare className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground">{t.name}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{t.prompt.substring(0, 80)}</p>
                    </div>
                    {t.isUser && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary-container/50 text-on-primary-container shrink-0">Custom</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Custom prompt option */}
              <div className="border-t border-outline-variant/50">
                <button
                  type="button"
                  onClick={() => setShowCustomPrompt(true)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-surface-container-low transition-colors cursor-pointer"
                >
                  <Sparkles className="h-4 w-4 text-primary shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-primary">Write your own prompt</p>
                    <p className="text-xs text-muted-foreground">Describe exactly what you want</p>
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
