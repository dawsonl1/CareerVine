"use client";

import { useState, useCallback } from "react";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { createActionItem } from "@/lib/queries";
import { ActionItemSource, SuggestionReasonType } from "@/lib/constants";
import { Sparkles, Check, X, Calendar, User, AlertTriangle } from "lucide-react";

interface TranscriptSuggestion {
  _key: string;
  title: string;
  description: string | null;
  contactId: number | null;
  contactName: string | null;
  dueDate: string | null;
  evidence: string;
  assignedSpeaker: string;
}

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
      // Assign stable keys to each suggestion
      const keyed = (data.suggestions || []).map((s: Omit<TranscriptSuggestion, "_key">, i: number) => ({
        ...s,
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
        suggestion_headline: `From meeting transcript`,
        suggestion_evidence: suggestion.evidence,
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
  if (!hasRun && !loading) {
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

  // Format a YYYY-MM-DD date string without timezone shifting
  const formatDate = (dateStr: string) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d); // local time, no UTC shift
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  // Show suggestions
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Suggested action items ({suggestions.length})
        </span>
      </div>
      {truncated && (
        <p className="text-[11px] text-muted-foreground mb-2">
          This transcript was truncated for analysis. Action items near the end may not be detected.
        </p>
      )}
      <div className="space-y-2">
        {suggestions.map((s) => (
          <div
            key={s._key}
            className="flex items-start gap-3 p-3 rounded-[8px] bg-surface-container"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{s.title}</p>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {s.contactName && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <User className="h-3 w-3" /> {s.contactName}
                  </span>
                )}
                {s.dueDate && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    {formatDate(s.dueDate)}
                  </span>
                )}
                {!s.contactName && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground italic">
                    <User className="h-3 w-3" /> {s.assignedSpeaker}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground italic line-clamp-2">
                &ldquo;{s.evidence}&rdquo;
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="tonal"
                size="sm"
                onClick={() => acceptSuggestion(s)}
                loading={savingKeys.has(s._key)}
                disabled={savingKeys.has(s._key)}
              >
                <Check className="h-3.5 w-3.5" /> Add
              </Button>
              <button
                type="button"
                onClick={() => dismissSuggestion(s._key)}
                className="p-1.5 rounded-full text-muted-foreground hover:text-foreground cursor-pointer"
                title="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
