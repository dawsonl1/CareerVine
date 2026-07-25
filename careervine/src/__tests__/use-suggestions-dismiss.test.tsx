// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";
import { useSuggestions } from "@/hooks/use-suggestions";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";

/**
 * CAR-188. `dismiss` dropped the card from local state and then fired an
 * unchecked POST with `.catch(() => {})`, so at 500, 401, or a network reject
 * the card vanished, the `contact_change_events` row stayed `'new'`, and the
 * same suggestion came back on the next load. The comment above the fetch
 * asserted the opposite of what the code did.
 *
 * There were two halves to that, and both had to move: the client stopped
 * checking, and `markChangeEventStatus` never checked the update's `error` at
 * all, so the route answered `200 {success:true}` on a write that never landed
 * (supabase-js resolves rather than throws). A client-side `res.ok` check is
 * worth nothing against a server that always says ok, which is why the two are
 * fixed together and why `change-events-dismiss-status.test.ts` sits beside
 * this file.
 */

const GENERATE = "POST /api/suggestions/generate";
const CHANGE_EVENTS = "GET /api/change-events";
const DISMISS = "POST /api/change-events/dismiss";

const CHANGE_EVENT_ID = 42;

function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: "ce-42",
    contactId: 7,
    contactName: "Ada Lovelace",
    contactPhotoUrl: null,
    contactIndustry: null,
    headline: "Started a new role",
    evidence: "Now Director of Engineering",
    reasonType: "job_change",
    score: 88,
    suggestedTitle: "Congratulate Ada",
    suggestedDescription: "",
    daysSinceContact: null,
    changeEventId: CHANGE_EVENT_ID,
    ...overrides,
  } as Suggestion;
}

/** Load one change-event-backed suggestion into the hook. */
async function loadOne(dismissRoute: Parameters<typeof installFakeFetch>[0][string]) {
  const http = installFakeFetch({
    [GENERATE]: { body: { suggestions: [] } },
    [CHANGE_EVENTS]: { body: { suggestions: [suggestion()] } },
    [DISMISS]: dismissRoute,
  });

  const view = renderHook(() => useSuggestions());
  await act(async () => {
    await view.result.current.load();
  });
  expect(view.result.current.suggestions).toHaveLength(1);
  return { http, view };
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

describe("useSuggestions.dismiss (CAR-188)", () => {
  it("puts the card back and reports false when the server refuses the dismissal", async () => {
    const { http, view } = await loadOne({ status: 500, body: { error: "boom" } });

    let settled: boolean | undefined;
    await act(async () => {
      settled = await view.result.current.dismiss(suggestion());
    });

    // The row is still 'new' server-side, so the card must still be here. The
    // old code left the user believing they had dismissed it until it returned.
    expect(settled).toBe(false);
    expect(view.result.current.suggestions).toHaveLength(1);
    expect(http.countOf(DISMISS)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("rolls back on a network reject too, not just a non-2xx", async () => {
    // The only failure the original bare try/catch could even observe, and it
    // did not act on that one either.
    const { http, view } = await loadOne({ reject: new TypeError("Failed to fetch") });

    let settled: boolean | undefined;
    await act(async () => {
      settled = await view.result.current.dismiss(suggestion());
    });

    expect(settled).toBe(false);
    expect(view.result.current.suggestions).toHaveLength(1);
    // Without these, a mistyped route key would throw from installFakeFetch and
    // produce the identical rollback, so the test would pass while proving
    // nothing about the reject path (CAR-204).
    expect(http.countOf(DISMISS)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("keeps the card gone and reports true when the dismissal lands", async () => {
    const { http, view } = await loadOne({ body: { success: true } });

    let settled: boolean | undefined;
    await act(async () => {
      settled = await view.result.current.dismiss(suggestion());
    });

    expect(settled).toBe(true);
    expect(view.result.current.suggestions).toHaveLength(0);
    expect(http.countOf(DISMISS)).toBe(1);
  });

  it("notifies the caller so it can toast, since the hook has none of its own", async () => {
    const onDismissFailed = vi.fn();
    const http = installFakeFetch({
      [GENERATE]: { body: { suggestions: [] } },
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()] } },
      [DISMISS]: { status: 401, body: { error: "Unauthorized" } },
    });

    const view = renderHook(() => useSuggestions({ onDismissFailed }));
    await act(async () => {
      await view.result.current.load();
    });
    await act(async () => {
      await view.result.current.dismiss(suggestion());
    });

    expect(onDismissFailed).toHaveBeenCalledTimes(1);
    expect(http.countOf(DISMISS)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });

  it("skips the round trip for an ephemeral suggestion with no change event", async () => {
    // AI suggestions are not persisted, so there is nothing to dismiss server
    // side and no failure mode to guard.
    const http = installFakeFetch({
      [GENERATE]: { body: { suggestions: [suggestion({ id: "ai-1", changeEventId: undefined })] } },
      [CHANGE_EVENTS]: { body: { suggestions: [] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      await view.result.current.load();
    });

    let settled: boolean | undefined;
    await act(async () => {
      settled = await view.result.current.dismiss(
        suggestion({ id: "ai-1", changeEventId: undefined }),
      );
    });

    expect(settled).toBe(true);
    expect(view.result.current.suggestions).toHaveLength(0);
    expect(http.countOf(DISMISS)).toBe(0);
    expect(http.unmatched).toEqual([]);
  });
});

describe("useSuggestions.dismiss rollback order (CAR-204)", () => {
  it("puts the card back where it was, not at the head of the list", async () => {
    // `[s, ...prev]` moved a rolled-back card to position 0. On the
    // action-items list that is a visible jump, and the dashboard's priority
    // sort does not hide it either: same-tier change events share a score and
    // Array.prototype.sort is stable, so the hook's order leaks through.
    const middle = suggestion({ id: "ce-42", contactId: 7 });
    const http = installFakeFetch({
      [GENERATE]: { body: { suggestions: [] } },
      [CHANGE_EVENTS]: {
        body: {
          suggestions: [
            suggestion({ id: "ce-1", contactId: 1 }),
            middle,
            suggestion({ id: "ce-3", contactId: 3 }),
          ],
        },
      },
      [DISMISS]: { status: 500, body: { error: "boom" } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => { await view.result.current.load(); });
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-1", "ce-42", "ce-3"]);

    await act(async () => { await view.result.current.dismiss(middle); });

    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-1", "ce-42", "ce-3"]);
    expect(http.countOf(DISMISS)).toBe(1);
    expect(http.unmatched).toEqual([]);
  });
});

describe("useSuggestions.save (CAR-204)", () => {
  it("returns false and keeps the card when the save is refused", async () => {
    // app/page.tsx gates the whole snooze branch on this boolean, and nothing
    // covered it. A regression to "always true" would make handleSnooze report
    // a snooze it never performed.
    const http = installFakeFetch({
      [GENERATE]: { body: { suggestions: [] } },
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()] } },
      "POST /api/suggestions/save": { status: 500, body: { error: "boom" } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => { await view.result.current.load(); });

    let ok: boolean | undefined;
    await act(async () => { ok = await view.result.current.save(suggestion()); });

    expect(ok).toBe(false);
    expect(view.result.current.suggestions).toHaveLength(1);
    expect(http.unmatched).toEqual([]);
  });

  it("returns true and removes the card when the save lands", async () => {
    const http = installFakeFetch({
      [GENERATE]: { body: { suggestions: [] } },
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()] } },
      "POST /api/suggestions/save": { body: { success: true } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => { await view.result.current.load(); });

    let ok: boolean | undefined;
    await act(async () => { ok = await view.result.current.save(suggestion()); });

    expect(ok).toBe(true);
    expect(view.result.current.suggestions).toHaveLength(0);
    expect(http.unmatched).toEqual([]);
  });
});

describe("useSuggestions.load (CAR-188)", () => {
  it("reports loadFailed only when BOTH sources fail", async () => {
    const http = installFakeFetch({
      [GENERATE]: { status: 500, body: {} },
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      await view.result.current.load();
    });

    // One source surviving is a result, not a failure: the change events are
    // real and must still render.
    expect(view.result.current.loadFailed).toBe(false);
    expect(view.result.current.suggestions).toHaveLength(1);
    expect(http.unmatched).toEqual([]);
  });

  it("reports loadFailed when neither source answers", async () => {
    installFakeFetch({
      [GENERATE]: { status: 500, body: {} },
      [CHANGE_EVENTS]: { status: 500, body: {} },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      await view.result.current.load();
    });

    // Without this an outage renders as "you have no suggestions today".
    expect(view.result.current.loadFailed).toBe(true);
    expect(view.result.current.suggestions).toHaveLength(0);
  });
});
