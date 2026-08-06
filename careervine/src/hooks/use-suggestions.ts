"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";
import { isAiFailureCode, type AiFailureCode } from "@/lib/ai-errors";
import { apiFetch, apiSend, jsonBody } from "@/lib/api-client";

/**
 * ── The regeneration gate (CAR-229) ──────────────────────────────────────
 *
 * `POST /api/suggestions/generate` measured 6,291ms on a production
 * /action-items load and was the single reason that page took 6.9s to
 * data-ready. This hook used to `Promise.allSettled` it against
 * /api/change-events and paint nothing until BOTH settled, so a ~200ms
 * persisted read was held behind a ~6s LLM pass, on every mount of two
 * different pages.
 *
 * Two separate things were wrong, and both are fixed here:
 *
 *   1. The feed waited on generation. It no longer does. Change events are
 *      persisted, indexed and fast; they paint on their own, and the AI half
 *      folds in whenever it arrives.
 *   2. Generation ran on every mount. Its inputs are days-since-touch,
 *      graduation dates and a 60-day decay threshold — quantities that do not
 *      move between two page loads a minute apart — so paying six seconds and
 *      an OpenAI call for a near-certainly identical answer was pure waste.
 *
 * The gate is a two-window SWR over the last result, kept in localStorage
 * under a server-named scope:
 *
 *   • fresher than STALE_AFTER  → paint the cache; issue NO generate request
 *   • STALE_AFTER … MAX_AGE     → paint the cache; regenerate in background
 *   • older than MAX_AGE, or no cache at all → paint change events only;
 *     regenerate in background
 *
 * A user who has never generated therefore still gets suggestions on their
 * first load — they arrive late rather than never, and are cached for next
 * time. An explicit refresh (`load()`, the retry banner) always regenerates
 * and always awaits, because the user asked and is watching a spinner.
 *
 * STALE_AFTER is hours rather than minutes because the underlying signals are
 * measured in days, and MAX_AGE exists so a laptop reopened after a week does
 * not paint a stale answer as if it were current.
 */
export const SUGGESTIONS_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const SUGGESTIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The AI half of the last successful load, as written to localStorage. */
interface CachedSuggestions {
  /** Client clock, compared only against this client's own `Date.now()`. */
  _ts: number;
  suggestions: Suggestion[];
  aiStatus: AiFailureCode | null;
}

const cacheKeyFor = (scope: string) => `careervine-suggestions:${scope}`;

/**
 * Read the cached AI half. Returns null on anything unexpected: a hostile or
 * merely outdated payload must degrade to "no cache" (one slow load) rather
 * than crash the feed.
 */
function readCache(scope: string): CachedSuggestions | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKeyFor(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedSuggestions> | null;
    if (typeof parsed?._ts !== "number" || !Array.isArray(parsed.suggestions)) return null;
    return {
      _ts: parsed._ts,
      suggestions: parsed.suggestions,
      aiStatus: isAiFailureCode(parsed.aiStatus) ? parsed.aiStatus : null,
    };
  } catch {
    return null;
  }
}

function writeCache(scope: string, entry: CachedSuggestions): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKeyFor(scope), JSON.stringify(entry));
  } catch {
    // error-tolerated: storage full, disabled, or a private-mode quota. The
    // cache is an optimization; losing it costs one slow load and nothing the
    // user sees says otherwise.
  }
}

/**
 * Change events lead (persisted, higher-signal), then AI suggestions. Deduped
 * by contact so one person never shows two rows, and filtered through the
 * contacts the user has already acted on this session — a merge that runs
 * after a save or dismissal must not put the card back.
 */
function mergeSuggestions(
  changeEvents: Suggestion[],
  ai: Suggestion[],
  removedContactIds: Set<number>,
): Suggestion[] {
  const seen = new Set<number>();
  const merged: Suggestion[] = [];
  for (const s of [...changeEvents, ...ai]) {
    if (seen.has(s.contactId) || removedContactIds.has(s.contactId)) continue;
    seen.add(s.contactId);
    merged.push(s);
  }
  return merged;
}

type GenerateOutcome =
  | { ok: true; suggestions: Suggestion[]; aiStatus: AiFailureCode | null }
  /**
   * `skipped` means a generation was already running and this call joined
   * nothing — distinct from a failure, because there is no bad news to report
   * and the run still in flight will paint its own result.
   */
  | { ok: false; skipped?: boolean };

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
  /** Mirrors `suggestions` so `dismiss` can read the pre-filter order. */
  const suggestionsRef = useRef<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  /** Both sources failed, so an empty list is a failure rather than a result. */
  const [loadFailed, setLoadFailed] = useState(false);
  // Set when the LLM pass couldn't run for lack of a usable OpenAI key. Surfaced
  // as a quiet, dismissible prompt — rule-based suggestions still render.
  const [aiStatus, setAiStatus] = useState<AiFailureCode | null>(null);
  const hasTriggered = useRef(false);

  /** Server-named namespace for this user's cache; null until change events answer. */
  const scopeRef = useRef<string | null>(null);
  /** The change-event half of the current load, so a late AI merge can re-merge. */
  const changeEventsRef = useRef<Suggestion[]>([]);
  /** The AI half, mirrored so save/dismiss can write through to the cache. */
  const aiRef = useRef<Suggestion[]>([]);
  /** `_ts` of the entry on disk, preserved across write-throughs so removing a
   *  card cannot silently extend the staleness window. */
  const aiGeneratedAtRef = useRef<number | null>(null);
  /**
   * Contacts the user has saved, completed or dismissed since the last load.
   * Background generation can land seconds after one of those clicks, and
   * without this the merge would resurrect the card they just cleared.
   */
  const removedContactIds = useRef<Set<number>>(new Set());
  /** True while a generate request is in flight. See `runGenerate`. */
  const generatingRef = useRef(false);

  // Mirrored so `persistAi` can read it without taking a dependency on render
  // order (a write-through fires from a click handler, not from `load`).
  const aiStatusRef = useRef<AiFailureCode | null>(null);

  // Both mirrors are maintained in an effect rather than assigned during render:
  // a render-phase ref write is what `react-hooks/refs` forbids, and React makes
  // no promise that a discarded render's writes are rolled back. Effects commit
  // before any click handler can run, which is the only place either ref is read.
  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);
  useEffect(() => {
    aiStatusRef.current = aiStatus;
  }, [aiStatus]);

  /** Persist the AI half under the current scope, if the scope is known yet. */
  const persistAi = useCallback((generatedAt: number | null) => {
    const scope = scopeRef.current;
    if (!scope || generatedAt === null) return;
    writeCache(scope, {
      _ts: generatedAt,
      suggestions: aiRef.current,
      aiStatus: aiStatusRef.current,
    });
  }, []);

  const runGenerate = useCallback(async (force: boolean): Promise<GenerateOutcome> => {
    // Synchronous re-entry guard, claimed before the first await and released in
    // finally. Not a double-click guard: two DIFFERENT paths reach this at once
    // — the background regeneration a mount schedules, and an explicit refresh
    // fired while it is still running. Unguarded that is two concurrent
    // six-second LLM passes, whose results then race to overwrite each other.
    if (generatingRef.current) return { ok: false, skipped: true };
    generatingRef.current = true;
    try {
      const res = await apiFetch<{ suggestions?: Suggestion[]; aiStatus?: unknown }>(
        "/api/suggestions/generate",
        jsonBody({ force }),
      );
      return {
        ok: true,
        suggestions: res.suggestions || [],
        aiStatus: isAiFailureCode(res.aiStatus) ? res.aiStatus : null,
      };
    } catch {
      return { ok: false };
    } finally {
      generatingRef.current = false;
    }
  }, []);

  /**
   * Fold a finished generation into the painted feed. The AI half is REPLACED
   * rather than appended: on an explicit refresh, a suggestion the new pass
   * dropped must leave the screen, and on the background path the cached half
   * it supersedes is the same list.
   */
  const applyGenerated = useCallback(
    (outcome: GenerateOutcome, changeEventsFailed: boolean) => {
      if (!outcome.ok) {
        // Every source we consulted failed and nothing cached survived, so an
        // empty list here would read as "you have no suggestions today"
        // (CAR-188 / CAR-204). One surviving source is a result, not a failure,
        // and a run that only stood aside for one already in flight is neither.
        if (!outcome.skipped && changeEventsFailed && aiRef.current.length === 0) {
          setLoadFailed(true);
        }
        return;
      }
      setAiStatus(outcome.aiStatus);
      aiStatusRef.current = outcome.aiStatus;
      // Filtered before it is cached, not just before it is painted: a
      // generation that started before the user cleared a card would otherwise
      // write that card back to disk and serve it again on the next mount.
      aiRef.current = outcome.suggestions.filter(
        (s) => !removedContactIds.current.has(s.contactId),
      );
      aiGeneratedAtRef.current = Date.now();
      persistAi(aiGeneratedAtRef.current);
      setSuggestions(
        mergeSuggestions(changeEventsRef.current, aiRef.current, removedContactIds.current),
      );
    },
    [persistAi],
  );

  /**
   * `gated: true` is the page-mount path — it paints as soon as change events
   * land and consults the gate before spending anything on regeneration.
   * Ungated (the default, and what the retry banner calls) is an explicit
   * refresh: it always regenerates, forces past the route's 60s memo, and
   * awaits the result so the caller's spinner means something.
   */
  const load = useCallback(
    async (opts?: { gated?: boolean }) => {
      const gated = opts?.gated === true;
      setLoading(true);
      setLoadFailed(false);
      // A load re-reads server truth: a dismissed event is 'dismissed' server
      // side and a saved one now has an action item that generation dedupes
      // against, so neither can come back and neither needs suppressing.
      removedContactIds.current.clear();

      // The ungated path regenerates unconditionally, so it can stay parallel
      // with the change-event read the way this hook always was. The gated path
      // cannot: whether to generate at all depends on a cache that cannot be
      // read until change events name its scope.
      const eagerGenerate = gated ? null : runGenerate(true);

      let changeEvents: Suggestion[] = [];
      let changeEventsFailed = false;
      let scope: string | null = null;
      try {
        const res = await apiFetch<{ suggestions?: Suggestion[]; cacheScope?: unknown }>(
          "/api/change-events",
        );
        changeEvents = res.suggestions || [];
        scope = typeof res.cacheScope === "string" ? res.cacheScope : null;
      } catch {
        changeEventsFailed = true;
      }
      scopeRef.current = scope;
      changeEventsRef.current = changeEvents;

      // No scope means no cache read — including when change events failed,
      // which costs a cached paint in an outage. That is the deliberate trade
      // for never painting one account's cards to another on a shared browser.
      const cached = scope ? readCache(scope) : null;
      const age = cached ? Date.now() - cached._ts : Infinity;
      const usable = cached && age < SUGGESTIONS_MAX_AGE_MS ? cached : null;
      aiRef.current = usable ? usable.suggestions : [];
      aiGeneratedAtRef.current = usable ? usable._ts : null;
      if (usable) {
        setAiStatus(usable.aiStatus);
        aiStatusRef.current = usable.aiStatus;
      }

      // Paint. Change events are server-fresh, the AI half is whatever the last
      // generation produced, and neither waited on the LLM.
      setSuggestions(
        mergeSuggestions(changeEventsRef.current, aiRef.current, removedContactIds.current),
      );
      setLoading(false);

      // ── The gate ──────────────────────────────────────────────────────
      if (gated && usable && age < SUGGESTIONS_STALE_AFTER_MS) return;

      const pending = eagerGenerate ?? runGenerate(false);
      if (gated) {
        // Background: the feed has already painted, so nothing waits on this.
        void pending.then((outcome) => applyGenerated(outcome, changeEventsFailed));
        return;
      }
      applyGenerated(await pending, changeEventsFailed);
    },
    [runGenerate, applyGenerated],
  );

  const dismissAiStatus = useCallback(() => setAiStatus(null), []);

  /**
   * Drop a suggestion from the AI half and write that through to the cache, so
   * a card the user cleared cannot be served back from cache on the next mount
   * — and cannot be re-merged by a generation still in flight.
   */
  const forgetSuggestion = useCallback(
    (s: Suggestion) => {
      removedContactIds.current.add(s.contactId);
      const remaining = aiRef.current.filter((x) => x.contactId !== s.contactId);
      if (remaining.length === aiRef.current.length) return;
      aiRef.current = remaining;
      // Keeps the original `_ts`: clearing a card is not a regeneration and
      // must not push the staleness window forward.
      persistAi(aiGeneratedAtRef.current);
    },
    [persistAi],
  );

  /** Undo `forgetSuggestion` when the server refused the write behind it. */
  const restoreSuggestion = useCallback(
    (s: Suggestion) => {
      removedContactIds.current.delete(s.contactId);
    },
    [],
  );

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
      forgetSuggestion(s);
      setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
      if (!opts?.completed) onSave?.();
      return true;
    } catch {
      return false;
    }
  }, [onSave, forgetSuggestion]);

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
    // Read from the ref rather than assigning inside the updater: React treats
    // updaters as pure and double-invokes them under StrictMode. The index is a
    // deterministic function of `prev` so the double-invoke would be harmless
    // here, but the same shortcut is genuinely wrong one file over (resolving a
    // promise twice), so it is not a habit worth keeping.
    //
    // Captured before the optimistic filter so the rollback can put the card
    // back where it was. `[s, ...prev]` moved it to the head, which is a visible
    // jump on the action-items list, and survives the dashboard's priority sort
    // too (same-tier events share a score and Array.sort is stable).
    const originalIndex = suggestionsRef.current.findIndex((x) => x.id === s.id);
    forgetSuggestion(s);
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id));
    if (s.changeEventId == null) return true;

    try {
      await apiSend("/api/change-events/dismiss", jsonBody({ changeEventId: s.changeEventId }));
      return true;
    } catch {
      restoreSuggestion(s);
      setSuggestions((prev) => {
        if (prev.some((x) => x.id === s.id)) return prev;
        const next = [...prev];
        next.splice(originalIndex < 0 ? 0 : Math.min(originalIndex, next.length), 0, s);
        return next;
      });
      onDismissFailed?.();
      return false;
    }
  }, [onDismissFailed, forgetSuggestion, restoreSuggestion]);

  /** Call once when ready to trigger loading (idempotent). */
  const triggerOnce = useCallback(() => {
    if (hasTriggered.current) return;
    hasTriggered.current = true;
    // Fire-and-forget: load catches its own errors and clears `loading`. Gated,
    // because a page mount is exactly the case the staleness window exists for.
    void load({ gated: true });
  }, [load]);

  return { suggestions, loading, loadFailed, aiStatus, dismissAiStatus, load, save, complete, dismiss, triggerOnce };
}
