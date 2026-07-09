"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";

interface UseSuggestionsOptions {
  /** Called after a suggestion is successfully saved (not completed) */
  onSave?: () => void;
}

/**
 * Shared hook for loading and managing ephemeral AI suggestions.
 * Used by both the dashboard and action items pages.
 */
export function useSuggestions({ onSave }: UseSuggestionsOptions = {}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const hasTriggered = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Ephemeral AI suggestions + persisted change events (plan 29), in parallel.
      const [aiRes, ceRes] = await Promise.all([
        fetch("/api/suggestions/generate", { method: "POST" }),
        fetch("/api/change-events"),
      ]);
      const ai: Suggestion[] = aiRes.ok ? (await aiRes.json()).suggestions || [] : [];
      const ce: Suggestion[] = ceRes.ok ? (await ceRes.json()).suggestions || [] : [];

      // Change events lead (persisted, higher-signal), then AI suggestions.
      // Dedupe by contact so one person never shows two rows.
      const seen = new Set<number>();
      const merged: Suggestion[] = [];
      for (const s of [...ce, ...ai]) {
        if (seen.has(s.contactId)) continue;
        seen.add(s.contactId);
        merged.push(s);
      }
      setSuggestions(merged);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  /** Internal: save a suggestion, optionally marking it as already completed. */
  const saveSuggestion = useCallback(async (s: Suggestion, opts?: { completed?: boolean }): Promise<boolean> => {
    try {
      const res = await fetch("/api/suggestions/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: s.contactId,
          title: s.suggestedTitle,
          description: s.suggestedDescription,
          reasonType: s.reasonType,
          headline: s.headline,
          evidence: s.evidence,
          ...(opts?.completed && { completed: true }),
          ...(s.changeEventId != null && { changeEventId: s.changeEventId }),
        }),
      });
      if (res.ok) {
        setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
        if (!opts?.completed) onSave?.();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [onSave]);

  const save = useCallback((s: Suggestion) => saveSuggestion(s), [saveSuggestion]);

  /** Mark a suggestion as already done — creates a completed action item. */
  const complete = useCallback((s: Suggestion) => saveSuggestion(s, { completed: true }), [saveSuggestion]);

  const dismiss = useCallback((s: Suggestion) => {
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    // Persisted change events must be dismissed server-side so they don't reappear.
    if (s.changeEventId != null) {
      fetch("/api/change-events/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeEventId: s.changeEventId }),
      }).catch(() => {});
    }
  }, []);

  /** Call once when ready to trigger loading (idempotent). */
  const triggerOnce = useCallback(() => {
    if (hasTriggered.current) return;
    hasTriggered.current = true;
    load();
  }, [load]);

  return { suggestions, loading, load, save, complete, dismiss, triggerOnce };
}
