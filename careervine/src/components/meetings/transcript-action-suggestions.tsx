"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { createActionItem } from "@/lib/queries";
import { ActionItemSource, SuggestionReasonType } from "@/lib/constants";
import { Sparkles, Check, X, Calendar, User, AlertTriangle, CheckSquare, Hourglass, Handshake, Pencil } from "lucide-react";

/** Compact inline date picker — renders as a small "Add date" button that opens a native date input */
function InlineDatePicker({ onSelect }: { onSelect: (date: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.showPicker?.()}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline cursor-pointer"
      >
        <Calendar className="h-3 w-3" />
        Add date
      </button>
      <input
        ref={inputRef}
        type="date"
        className="sr-only"
        onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
      />
    </>
  );
}

type Direction = "my_task" | "waiting_on" | "mutual";

interface TranscriptSuggestion {
  _key: string;
  title: string;
  description: string | null;
  contactId: number | null;
  contactName: string | null;
  dueDate: string | null;
  evidence: string;
  assignedSpeaker: string;
  direction: Direction;
}

const DIRECTION_OPTIONS: { value: Direction; label: string }[] = [
  { value: "my_task", label: "My task" },
  { value: "waiting_on", label: "Waiting on them" },
  { value: "mutual", label: "Mutual" },
];

const DIRECTION_CONFIG: Record<Direction, { icon: typeof CheckSquare; label: string; color: string }> = {
  my_task: { icon: CheckSquare, label: "Your commitments", color: "text-primary" },
  waiting_on: { icon: Hourglass, label: "Waiting on", color: "text-amber-600 dark:text-amber-400" },
  mutual: { icon: Handshake, label: "Mutual", color: "text-muted-foreground" },
};

interface TranscriptActionSuggestionsProps {
  meetingId: number;
  userId: string;
  transcript: string;
  attendees: { id: number; name: string }[];
  meetingDate: string;
  onActionCreated: () => void;
}

export function TranscriptActionSuggestions({
  meetingId,
  userId,
  transcript,
  attendees,
  meetingDate,
  onActionCreated,
}: TranscriptActionSuggestionsProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [suggestions, setSuggestions] = useState<TranscriptSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Focus the edit input when editing starts
  useEffect(() => {
    if (editingKey && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingKey]);

  const extractActions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/transcripts/extract-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meetingId,
          transcript,
          attendees,
          meetingDate,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to extract action items");
      }

      const data = await res.json();
      const keyed = (data.suggestions || []).map((s: Omit<TranscriptSuggestion, "_key">, i: number) => ({
        ...s,
        direction: s.direction || "my_task",
        _key: `${i}-${s.title.slice(0, 20)}`,
      }));
      setSuggestions(keyed);
      setTruncated(data.truncated || false);
      setHasRun(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, [meetingId, transcript, attendees, meetingDate]);

  const updateSuggestion = useCallback((key: string, updates: Partial<TranscriptSuggestion>) => {
    setSuggestions((prev) => prev.map((s) => s._key === key ? { ...s, ...updates } : s));
  }, []);

  const acceptSuggestion = async (suggestion: TranscriptSuggestion) => {
    setSavingKeys((prev) => new Set(prev).add(suggestion._key));
    try {
      const contactIds = suggestion.contactId ? [suggestion.contactId] : [];
      await createActionItem({
        user_id: userId,
        contact_id: suggestion.contactId,
        meeting_id: meetingId,
        title: suggestion.title,
        description: suggestion.description,
        due_at: suggestion.dueDate,
        is_completed: false,
        created_at: new Date().toISOString(),
        completed_at: null,
        source: ActionItemSource.AiTranscript,
        suggestion_reason_type: SuggestionReasonType.TranscriptExtracted,
        suggestion_headline: "From meeting transcript",
        suggestion_evidence: suggestion.evidence,
        direction: suggestion.direction,
        assigned_speaker: suggestion.assignedSpeaker,
      }, contactIds);

      setSuggestions((prev) => prev.filter((s) => s._key !== suggestion._key));
      onActionCreated();
      toastSuccess("Action item created");
    } catch {
      toastError("Failed to create action item");
    } finally {
      setSavingKeys((prev) => {
        const next = new Set(prev);
        next.delete(suggestion._key);
        return next;
      });
    }
  };

  const dismissSuggestion = (key: string) => {
    setSuggestions((prev) => prev.filter((s) => s._key !== key));
  };

  // Not yet triggered — show the button
  if (!hasRun && !loading && !error) {
    return (
      <button
        type="button"
        onClick={extractActions}
        className="flex items-center gap-2 text-xs text-primary hover:underline cursor-pointer mt-2"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Suggest action items from transcript
      </button>
    );
  }

  // Loading state
  if (loading) {
    return (
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-primary animate-pulse" />
          Analyzing transcript...
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 rounded-[8px] bg-surface-container animate-pulse" />
        ))}
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" />
        {error}
        <button
          type="button"
          onClick={extractActions}
          className="text-primary hover:underline cursor-pointer ml-1"
        >
          Retry
        </button>
      </div>
    );
  }

  // No suggestions found
  if (suggestions.length === 0) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        No action items found in this transcript.
      </div>
    );
  }

  // Group by direction
  const groups: { direction: Direction; items: TranscriptSuggestion[] }[] = [];
  const myTasks = suggestions.filter((s) => s.direction === "my_task");
  const waitingOn = suggestions.filter((s) => s.direction === "waiting_on");
  const mutual = suggestions.filter((s) => s.direction === "mutual");
  if (myTasks.length > 0) groups.push({ direction: "my_task", items: myTasks });
  if (waitingOn.length > 0) groups.push({ direction: "waiting_on", items: waitingOn });
  if (mutual.length > 0) groups.push({ direction: "mutual", items: mutual });

  // Derive contact name for "Waiting on" header
  const waitingContactName = waitingOn[0]?.contactName || waitingOn[0]?.assignedSpeaker || "them";

  // Format a YYYY-MM-DD date string without timezone shifting
  const formatDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const renderSuggestionCard = (s: TranscriptSuggestion) => {
    const isEditing = editingKey === s._key;
    const isSaving = savingKeys.has(s._key);

    return (
      <div
        key={s._key}
        className="p-3 rounded-[8px] bg-surface-container"
      >
        {/* Title row — editable inline */}
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <input
                ref={editInputRef}
                type="text"
                value={s.title}
                onChange={(e) => updateSuggestion(s._key, { title: e.target.value })}
                onBlur={() => setEditingKey(null)}
                onKeyDown={(e) => { if (e.key === "Enter") setEditingKey(null); }}
                className="w-full text-sm font-medium text-foreground bg-transparent border-b border-primary outline-none pb-0.5"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingKey(s._key)}
                className="text-sm font-medium text-foreground text-left w-full cursor-text hover:text-primary transition-colors group flex items-center gap-1"
              >
                <span className="truncate">{s.title}</span>
                <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
              </button>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="tonal"
              size="sm"
              onClick={() => acceptSuggestion(s)}
              loading={isSaving}
              disabled={isSaving || !s.title.trim()}
            >
              <Check className="h-3.5 w-3.5" /> Add
            </Button>
            <button
              type="button"
              onClick={() => dismissSuggestion(s._key)}
              disabled={isSaving}
              className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Metadata row — direction selector, date picker, contact */}
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {/* Direction selector */}
          <select
            value={s.direction}
            onChange={(e) => updateSuggestion(s._key, { direction: e.target.value as Direction })}
            className="h-7 px-2 text-[11px] font-medium rounded-full border border-outline-variant bg-surface-container-low text-foreground cursor-pointer focus:outline-none focus:border-primary"
          >
            {DIRECTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>

          {/* Due date — clickable to set/clear */}
          {s.dueDate ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              <button
                type="button"
                onClick={() => updateSuggestion(s._key, { dueDate: null })}
                className="hover:line-through cursor-pointer"
                title="Remove due date"
              >
                {formatDate(s.dueDate)}
              </button>
            </span>
          ) : (
            <InlineDatePicker onSelect={(val) => updateSuggestion(s._key, { dueDate: val })} />
          )}

          {/* Contact indicator */}
          {s.contactName ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <User className="h-3 w-3" /> {s.contactName}
            </span>
          ) : s.assignedSpeaker ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground italic">
              <User className="h-3 w-3" /> {s.assignedSpeaker}
            </span>
          ) : null}
        </div>

        {/* Evidence quote */}
        <p className="mt-1.5 text-xs text-muted-foreground italic line-clamp-2">
          &ldquo;{s.evidence}&rdquo;
        </p>
      </div>
    );
  };

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Extracted action items ({suggestions.length})
        </span>
      </div>
      {truncated && (
        <p className="text-[11px] text-muted-foreground mb-2">
          This transcript was truncated for analysis. Action items near the end may not be detected.
        </p>
      )}

      <div className="space-y-4">
        {groups.map(({ direction, items }) => {
          const config = DIRECTION_CONFIG[direction];
          const Icon = config.icon;
          const label = direction === "waiting_on"
            ? `${config.label} ${waitingContactName}`
            : config.label;

          return (
            <div key={direction}>
              <div className={`flex items-center gap-1.5 mb-2 ${config.color}`}>
                <Icon className="h-3.5 w-3.5" />
                <span className="text-xs font-medium uppercase tracking-wider">
                  {label} ({items.length})
                </span>
              </div>
              <div className="space-y-2">
                {items.map(renderSuggestionCard)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
