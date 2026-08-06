// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { installFakeFetch } from "./helpers/fake-fetch";
import {
  useSuggestions,
  SUGGESTIONS_STALE_AFTER_MS,
  SUGGESTIONS_MAX_AGE_MS,
} from "@/hooks/use-suggestions";
import type { Suggestion } from "@/lib/ai-followup/suggestion-types";

/**
 * CAR-229. `POST /api/suggestions/generate` measured 6,291ms in production and
 * the feed used to `Promise.allSettled` it against `/api/change-events`,
 * painting nothing until both settled — so a ~200ms persisted read waited on a
 * ~6s LLM pass, on every mount of two different pages.
 *
 * These tests pin the two halves of the fix, which fail in different ways:
 *
 *   • the PAINT no longer waits on generation (a hung generate must not hold
 *     change events off the screen), and
 *   • the GATE means a fresh cache issues no generate request AT ALL.
 *
 * The second is the one that needs care to test honestly. `installFakeFetch`
 * throws on an undeclared route AND records it in `unmatched`, so "the gate
 * held" is asserted as `unmatched` being empty with GENERATE simply not
 * declared — a request that slipped through cannot be swallowed by the hook's
 * own catch and pass silently. Where GENERATE *is* declared, `countOf` carries
 * the assertion instead.
 */

const GENERATE = "POST /api/suggestions/generate";
const CHANGE_EVENTS = "GET /api/change-events";
const SAVE = "POST /api/suggestions/save";
const DISMISS = "POST /api/change-events/dismiss";

const SCOPE = "a1b2c3d4e5f60718";
const CACHE_KEY = `careervine-suggestions:${SCOPE}`;

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
    changeEventId: 42,
    ...overrides,
  } as Suggestion;
}

/** An AI-half suggestion: ephemeral, so no changeEventId. */
function aiSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return suggestion({
    id: "llm-9",
    contactId: 9,
    contactName: "Grace Hopper",
    changeEventId: undefined,
    ...overrides,
  });
}

/**
 * This suite's jsdom has NO localStorage — vitest's jsdom environment leaves it
 * undefined here (`home-page.test.tsx` already works around the same gap with a
 * try/catch around `localStorage.clear()`). The hook survives that on its own,
 * since every access sits inside a try/catch and an absent store degrades to
 * "no cache", but a suite about caching that ran against no store would assert
 * nothing. So install a real one per test.
 */
function installMemoryStorage(): Storage {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  vi.stubGlobal("localStorage", store);
  return store;
}

let storage: Storage;

/**
 * Hold GENERATE open — the 6.3s production call, minus the wall clock.
 *
 * Wraps the fake-fetch router rather than replacing it, and counts STARTS
 * itself. `http.countOf` cannot serve here: the wrapper suspends before it
 * forwards, so a request that has been issued and is hanging is recorded
 * nowhere, and asserting `countOf(GENERATE) === 0` while one is outstanding
 * would pass whether or not the request was made.
 */
function hangGenerate() {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  const routed = global.fetch as unknown as (i: RequestInfo | URL, n?: RequestInit) => Promise<Response>;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/suggestions/generate")) {
      starts += 1;
      await gate;
    }
    return routed(input, init);
  });
  return {
    starts: () => starts,
    async release() {
      await act(async () => {
        release?.();
        await gate;
      });
    },
  };
}

function seedCache(ageMs: number, suggestions: Suggestion[], aiStatus: string | null = null) {
  storage.setItem(
    CACHE_KEY,
    JSON.stringify({ _ts: Date.now() - ageMs, suggestions, aiStatus }),
  );
}

function readCache() {
  const raw = storage.getItem(CACHE_KEY);
  return raw ? (JSON.parse(raw) as { _ts: number; suggestions: Suggestion[]; aiStatus: string | null }) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage = installMemoryStorage();
});
afterEach(() => vi.unstubAllGlobals());

describe("useSuggestions gate — a fresh cache skips generation entirely (CAR-229)", () => {
  it("issues NO generate request when the cached result is inside the staleness window", async () => {
    seedCache(SUGGESTIONS_STALE_AFTER_MS - 60_000, [aiSuggestion()]);
    // GENERATE is deliberately undeclared: any call lands in `unmatched`.
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(http.countOf(GENERATE)).toBe(0);
    expect(http.unmatched).toEqual([]);
    // The whole point: the user still sees both halves, the cached one included.
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42", "llm-9"]);
    expect(view.result.current.loadFailed).toBe(false);
  });

  it("regenerates in the background once the cache passes the staleness window", async () => {
    seedCache(SUGGESTIONS_STALE_AFTER_MS + 60_000, [aiSuggestion()]);
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [aiSuggestion({ id: "llm-11", contactId: 11 })] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    // Stale is still servable, so the cached card paints rather than a spinner.
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(2));
    await waitFor(() => expect(http.countOf(GENERATE)).toBe(1));
    // ...and is REPLACED, not appended to, when the fresh pass lands. Appending
    // would leave a suggestion the new pass dropped on screen forever.
    await waitFor(() =>
      expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42", "llm-11"]),
    );
    expect(http.unmatched).toEqual([]);
  });

  it("ignores a cache older than the max age instead of painting it", async () => {
    seedCache(SUGGESTIONS_MAX_AGE_MS + 60_000, [aiSuggestion()]);
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    // A week-old answer must not masquerade as current, so only the persisted
    // change event survives the first paint.
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42"]);
    await waitFor(() => expect(http.countOf(GENERATE)).toBe(1));
    expect(http.unmatched).toEqual([]);
  });

  it("generates for a user who has never generated, so a first load still gets suggestions", async () => {
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [aiSuggestion()] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    await waitFor(() => expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["llm-9"]));
    expect(http.countOf(GENERATE)).toBe(1);
    // And the result is banked, so the next mount pays nothing.
    expect(readCache()?.suggestions.map((s) => s.id)).toEqual(["llm-9"]);
    expect(http.unmatched).toEqual([]);
  });

  it("never reads a cache the server has not scoped, so one account cannot paint another's cards", async () => {
    seedCache(0, [aiSuggestion()]);
    // No cacheScope in the response — an older server, or a response shape that
    // drifted. The cache must be unreachable rather than guessed at.
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()] } },
      [GENERATE]: { body: { suggestions: [] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42"]);
    // Unscoped means ungated too — it has to fall back to generating.
    await waitFor(() => expect(http.countOf(GENERATE)).toBe(1));
    expect(http.unmatched).toEqual([]);
  });

  it("treats a corrupt cache entry as absent rather than throwing", async () => {
    storage.setItem(CACHE_KEY, "{not json");
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42"]);
    await waitFor(() => expect(http.countOf(GENERATE)).toBe(1));
    expect(http.unmatched).toEqual([]);
  });
});

describe("useSuggestions paint — change events no longer wait on generation (CAR-229)", () => {
  it("paints the persisted half while generation is still in flight", async () => {
    installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [aiSuggestion()] } },
    });
    const generate = hangGenerate();

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    // The assertion that would have failed before this change: the feed is
    // painted and out of its loading state with generation genuinely
    // outstanding — issued (starts === 1) and not yet answered.
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42"]);
    expect(generate.starts()).toBe(1);

    await generate.release();
    await waitFor(() =>
      expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42", "llm-9"]),
    );
  });

  it("settles the mount load without waiting for generation", async () => {
    // The paint test above covers what the user sees. This covers the promise:
    // `load({ gated: true })` must RESOLVE with generation still outstanding,
    // so a caller that ever awaits the mount path (the pages currently
    // fire-and-forget it) cannot reintroduce the 6s block by accident.
    installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [] } },
    });
    const generate = hangGenerate();

    const view = renderHook(() => useSuggestions());
    let settled = false;
    await act(async () => {
      await view.result.current.load({ gated: true });
      settled = true;
    });

    expect(settled).toBe(true);
    expect(generate.starts()).toBe(1);
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42"]);
    await generate.release();
  });

  it("still surfaces a load failure when change events fail and generation fails too", async () => {
    installFakeFetch({
      [CHANGE_EVENTS]: { status: 500, body: {} },
      [GENERATE]: { status: 500, body: {} },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    // Without this an outage renders as "you have no suggestions today".
    await waitFor(() => expect(view.result.current.loadFailed).toBe(true));
    expect(view.result.current.suggestions).toHaveLength(0);
  });

  it("does not report a failure when generation fails but change events answered", async () => {
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { status: 500, body: {} },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    await waitFor(() => expect(http.countOf(GENERATE)).toBe(1));
    expect(view.result.current.loadFailed).toBe(false);
    expect(view.result.current.suggestions).toHaveLength(1);
    // A failed pass must not overwrite a good cache with nothing.
    expect(readCache()).toBeNull();
  });
});

describe("useSuggestions explicit refresh bypasses the gate (CAR-229)", () => {
  it("regenerates with force even when the cache is fresh", async () => {
    seedCache(0, [aiSuggestion()]);
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [aiSuggestion({ id: "llm-12", contactId: 12 })] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      await view.result.current.load();
    });

    expect(http.countOf(GENERATE)).toBe(1);
    // `force` clears the route's 60s per-user memo. Without it a retry inside
    // that window returns the identical result and the button lies.
    expect(http.bodyOf(GENERATE)).toEqual({ force: true });
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["llm-12"]);
    expect(http.unmatched).toEqual([]);
  });

  it("sends force:false on the background path, so a mount cannot burn the memo", async () => {
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [] } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });

    await waitFor(() => expect(http.countOf(GENERATE)).toBe(1));
    expect(http.bodyOf(GENERATE)).toEqual({ force: false });
  });
});

describe("useSuggestions in-flight guard (CAR-229)", () => {
  it("does not issue a second generate while one is still running", async () => {
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [aiSuggestion()] } },
    });
    const generate = hangGenerate();

    const view = renderHook(() => useSuggestions());
    // Mount schedules a background generation; the user then hammers retry
    // while it is still out. Two concurrent six-second LLM passes would race to
    // overwrite each other, and the loser's result is the one that sticks.
    await act(async () => {
      view.result.current.triggerOnce();
    });
    await act(async () => {
      await view.result.current.load();
      await view.result.current.load();
    });

    expect(generate.starts()).toBe(1);
    // A stood-aside run is not a failure: nothing failed and the run in flight
    // will still paint.
    expect(view.result.current.loadFailed).toBe(false);

    await generate.release();
    await waitFor(() => expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["llm-9"]));
    expect(http.unmatched).toEqual([]);
  });
});

describe("useSuggestions cache write-through (CAR-229)", () => {
  it("drops a saved suggestion from the cache so it cannot come back on the next mount", async () => {
    seedCache(0, [aiSuggestion()]);
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [], cacheScope: SCOPE } },
      [SAVE]: { body: { success: true } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));

    const before = readCache()!._ts;
    await act(async () => {
      await view.result.current.save(aiSuggestion());
    });

    expect(view.result.current.suggestions).toHaveLength(0);
    expect(readCache()?.suggestions).toEqual([]);
    // Clearing a card is not a regeneration: the timestamp must not move, or
    // working through the list would keep pushing the staleness window out.
    expect(readCache()?._ts).toBe(before);
    expect(http.unmatched).toEqual([]);
  });

  it("does not let a generation in flight resurrect a card cleared while it ran", async () => {
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [GENERATE]: { body: { suggestions: [aiSuggestion(), suggestion()] } },
      [DISMISS]: { body: { success: true } },
    });
    const generate = hangGenerate();

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));

    // Dismiss the change event WHILE the 6s pass is still outstanding.
    await act(async () => {
      await view.result.current.dismiss(suggestion());
    });
    expect(view.result.current.suggestions).toHaveLength(0);

    await generate.release();

    // The pass returns a suggestion for the same contact. Painting it would
    // undo the click the user just made and watched succeed.
    await waitFor(() => expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["llm-9"]));
    expect(readCache()?.suggestions.map((s) => s.id)).toEqual(["llm-9"]);
    expect(http.unmatched).toEqual([]);
  });

  it("keeps the card and the cache intact when the dismissal is refused", async () => {
    seedCache(0, []);
    const http = installFakeFetch({
      [CHANGE_EVENTS]: { body: { suggestions: [suggestion()], cacheScope: SCOPE } },
      [DISMISS]: { status: 500, body: { error: "boom" } },
    });

    const view = renderHook(() => useSuggestions());
    await act(async () => {
      view.result.current.triggerOnce();
    });
    await waitFor(() => expect(view.result.current.suggestions).toHaveLength(1));

    await act(async () => {
      await view.result.current.dismiss(suggestion());
    });

    // Rolled back on screen, and the contact must not stay suppressed either —
    // a later merge has to be allowed to show it again.
    expect(view.result.current.suggestions.map((s) => s.id)).toEqual(["ce-42"]);
    expect(http.unmatched).toEqual([]);
  });
});
