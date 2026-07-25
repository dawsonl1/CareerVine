"use client";

import { useState, useCallback, useRef } from "react";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";
import { isAiFailureCode, type AiFailureCode } from "@/lib/ai-errors";
import { apiFetch, apiSend, jsonBody } from "@/lib/api-client";

interface UseSuggestionsOptions {
  /** Called after a suggestion is successfully saved (not completed) */
  onSave?: () => void;
  /**
   * Called when a server-side dismissal was refused and the card was put back.
   * The hook has no toast of its own (it is used by two different pages), so
   * the caller owns how that failure is surfaced.
   */
  onDismissFailed?: () => void;
}

/**
 * Shared hook for loading and managing ephemeral AI suggestions.
 * Used by both the dashboard and action items pages.
 */
export function useSuggestions({ onSave, onDismissFailed }: UseSuggestionsOptions = {}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  /** Both sources failed, so an empty list is a failure rather than a result. */
  const [loadFailed, setLoadFailed] = useState(false);
  // Set when the LLM pass couldn't run for lack of a usable OpenAI key. Surfaced
  // as a quiet, dismissible prompt — rule-based suggestions still render.
  const [aiStatus, setAiStatus] = useState<AiFailureCode | null>(null);
  const hasTriggered = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      // Ephemeral AI suggestions + persisted change events (plan 29), in
      // parallel. allSettled rather than all: these are two independent
      // sources and one failing should still surface the other, which is what
      // the old `if (res.ok)` pair achieved by hand.
      const [aiResult, ceResult] = await Promise.allSettled([
        apiFetch<{ suggestions?: Suggestion[]; aiStatus?: unknown }>(
          "/api/suggestions/generate",
          { method: "POST" },
        ),
        apiFetch<{ suggestions?: Suggestion[] }>("/api/change-events"),
      ]);
      let ai: Suggestion[] = [];
      if (aiResult.status === "fulfilled") {
        ai = aiResult.value.suggestions || [];
        setAiStatus(isAiFailureCode(aiResult.value.aiStatus) ? aiResult.value.aiStatus : null);
      }
      const ce: Suggestion[] =
        ceResult.status === "fulfilled" ? ceResult.value.suggestions || [] : [];
      setLoadFailed(aiResult.status === "rejected" && ceResult.status === "rejected");

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
      // Only reachable if the merge itself throws; both reads are settled above.
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const dismissAiStatus = useCallback(() => setAiStatus(null), []);

  /** Internal: save a suggestion, optionally marking it as already completed. */
  const saveSuggestion = useCallback(async (s: Suggestion, opts?: { completed?: boolean }): Promise<boolean> => {
    try {
      await apiSend("/api/suggestions/save", jsonBody({
        contactId: s.contactId,
        title: s.suggestedTitle,
        description: s.suggestedDescription,
        reasonType: s.reasonType,
        headline: s.headline,
        evidence: s.evidence,
        ...(opts?.completed && { completed: true }),
        ...(s.changeEventId != null && { changeEventId: s.changeEventId }),
      }));
      setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
      if (!opts?.completed) onSave?.();
      return true;
    } catch {
      return false;
    }
  }, [onSave]);

  const save = useCallback((s: Suggestion) => saveSuggestion(s), [saveSuggestion]);

  /** Mark a suggestion as already done — creates a completed action item. */
  const complete = useCallback((s: Suggestion) => saveSuggestion(s, { completed: true }), [saveSuggestion]);

  /**
   * Persisted change events must be dismissed server-side so they don't
   * reappear. This dropped the card locally and then fired the POST unchecked
   * with `.catch(() => {})`, so at 500, 401 or a network reject the card
   * vanished, the row stayed `'new'`, and it came back on the next load. The
   * comment above the fetch asserted the opposite of what the code did
   * (CAR-188). Now optimistic-with-rollback: the card goes immediately, and
   * comes back with a toast if the server refused it.
   *
   * Returns whether the dismissal stuck, so a caller that also does something
   * irreversible on the same click can gate on it.
   */
  const dismiss = useCallback(async (s: Suggestion): Promise<boolean> => {
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    if (s.changeEventId == null) return true;

    try {
      await apiSend("/api/change-events/dismiss", jsonBody({ changeEventId: s.changeEventId }));
      return true;
    } catch {
      setSuggestions((prev) => (prev.some((x) => x.id === s.id) ? prev : [s, ...prev]));
      onDismissFailed?.();
      return false;
    }
  }, [onDismissFailed]);

  /** Call once when ready to trigger loading (idempotent). */
  const triggerOnce = useCallback(() => {
    if (hasTriggered.current) return;
    hasTriggered.current = true;
    // Fire-and-forget: load catches its own errors and clears `loading`.
    void load();
  }, [load]);

  return { suggestions, loading, loadFailed, aiStatus, dismissAiStatus, load, save, complete, dismiss, triggerOnce };
}
