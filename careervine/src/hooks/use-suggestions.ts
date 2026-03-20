"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";

interface UseSuggestionsOptions {
  /** Called after a suggestion is successfully saved */
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
      const res = await fetch("/api/suggestions/generate", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setSuggestions(data.suggestions || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(async (s: Suggestion): Promise<boolean> => {
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
        }),
      });
      if (res.ok) {
        setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
        onSave?.();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [onSave]);

  const dismiss = useCallback((s: Suggestion) => {
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
  }, []);

  /** Call once when ready to trigger loading (idempotent). */
  const triggerOnce = useCallback(() => {
    if (hasTriggered.current) return;
    hasTriggered.current = true;
    load();
  }, [load]);

  return { suggestions, loading, load, save, dismiss, triggerOnce };
}
