"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  consumeAnchor,
  consumePopNavigation,
  recallScroll,
  rememberScroll,
  rememberAnchor as storeAnchor,
} from "@/lib/scroll-memory";

/**
 * Puts a list page back where the user left it when they come back to it
 * (CAR-256). See `src/lib/scroll-memory.ts` for the storage shape and for why a
 * back navigation has to be distinguished from a fresh visit.
 *
 * Restoration is gated on `ready`, which callers pass as "the content on screen
 * came from cache". Two things follow from that:
 *
 *   * the document is already at full height, so the scroll actually lands
 *     (this is the whole reason the browser's own restore fails today — it
 *     fires while the page still reads "Loading companies…" and clamps to 0);
 *   * a genuine refetch never restores. Jumping the user down the page after
 *     they have already waited and started reading the top is worse than the
 *     reset it would be fixing. CAR-278 makes the cached path far more common
 *     rather than relaxing this; the rule itself stands.
 *
 * ── Offset first, anchor as the rescue (CAR-278) ─────────────────────────
 *
 * A pixel offset is the better answer whenever it is available, because it
 * reproduces the view exactly instead of re-centring on a row. It stops being
 * available when the list changed while the user was away — which is now the
 * normal case, since a write refreshes the cache in the background. So the
 * offset is applied first, and the anchored row is scrolled into view only if it
 * is not on screen once the offset has landed. An unchanged list therefore never
 * moves, and a row that has vanished entirely leaves the offset standing.
 */

// `useLayoutEffect` has no meaning during SSR and React warns about it there.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface UseScrollRestorationOptions {
  pathname: string;
  /** The full query string, so each filtered view remembers its own position. */
  search: string;
  /** Content is on screen at full height. Restoration fires once, when this turns true. */
  ready: boolean;
}

export interface ScrollRestoration {
  /**
   * Record the row being navigated into, so the return trip can find it even if
   * the list has been reordered underneath. Call it from the row's own click
   * handler; the matching element must carry `data-scroll-anchor="<anchor>"`.
   */
  rememberAnchor: (anchor: string) => void;
}

/** How a remembered anchor is located in the DOM. */
function findAnchor(anchor: string): HTMLElement | null {
  // `CSS.escape` is guarded rather than assumed: jsdom has it, but this runs in
  // whatever the caller's environment is and an id containing a quote would
  // otherwise build a selector that throws inside a layout effect.
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(anchor) : anchor;
  const el = document.querySelector(`[data-scroll-anchor="${escaped}"]`);
  return el instanceof HTMLElement ? el : null;
}

export function useScrollRestoration({
  pathname,
  search,
  ready,
}: UseScrollRestorationOptions): ScrollRestoration {
  const signalsReadRef = useRef(false);
  const wasPopRef = useRef(false);
  const anchorRef = useRef<string | null>(null);
  const restoredRef = useRef(false);

  // Both one-shot signals are read at MOUNT, not when `ready` turns true. The
  // pop signal expires, and the gap between the two is a fetch away in the worst
  // case. The anchor is consumed on the same schedule and for the same reason in
  // reverse: it describes the trip that just ended, so a mount that will never
  // restore (a real fetch, or a visit from the nav bar) still has to clear it,
  // or it springs on some later, unrelated return to this view.
  //
  // Declared first so both are set before the restore effect below reads them on
  // this same commit.
  useIsomorphicLayoutEffect(() => {
    if (signalsReadRef.current) return;
    signalsReadRef.current = true;
    wasPopRef.current = consumePopNavigation();
    anchorRef.current = consumeAnchor(pathname, search);
  }, [pathname, search]);

  useIsomorphicLayoutEffect(() => {
    if (restoredRef.current || !ready || !wasPopRef.current) return;
    // One shot either way: if the conditions are met and we decline below, we
    // decline permanently rather than pouncing on a later render.
    restoredRef.current = true;

    // Next runs its own popstate restoration. When that one succeeds there is
    // nothing to fix, and re-applying a remembered value on top of it would
    // fight the framework for no gain.
    if (window.scrollY === 0) {
      const y = recallScroll(pathname, search);
      if (y !== null && y > 0) window.scrollTo(0, y);
    }

    // Whatever put the page at that offset — us or Next — it was measured
    // against the list as it used to be. If the row the user left through is not
    // actually on screen, the offset missed and the anchor is the ground truth.
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const el = findAnchor(anchor);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
    el.scrollIntoView({ block: "center" });
  }, [ready, pathname, search]);

  // Record the position continuously. rAF-throttled because `scroll` fires far
  // more often than sessionStorage should be written.
  useEffect(() => {
    /**
     * Is this scroll still about the page we are recording for?
     *
     * It is not, at the one moment that matters most. Navigating to a company
     * makes Next scroll the outgoing page back to the top, and that scroll
     * reaches this listener while the list is still mounted — so an unguarded
     * listener overwrites the offset with 0 and destroys the very value the
     * return trip is supposed to restore. It is the same 0 the cleanup below
     * refuses, arriving through the door the cleanup does not cover.
     *
     * The live PATHNAME is the discriminator: by then the address bar is
     * already on `/companies/<id>`. Guarding on the offset instead would be
     * wrong in the other direction, since scrolling back to the top is a real
     * thing a user does and must be recorded.
     *
     * Pathname only, deliberately not the query string. `search` here is
     * `URLSearchParams.toString()`, which has no leading "?" and re-encodes
     * (`Big Tech` as `Big+Tech`) where `window.location.search` may not, so
     * comparing the two would mismatch on ordinary filters and silently switch
     * recording off altogether. A filter change keeps the pathname anyway, and
     * those scrolls are ours to record.
     */
    const stillOnThisView = () => window.location.pathname === pathname;

    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!stillOnThisView()) return;
        rememberScroll(pathname, search, window.scrollY);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      // Catch a scroll that landed inside the last un-fired frame.
      if (stillOnThisView() && window.scrollY > 0) {
        rememberScroll(pathname, search, window.scrollY);
      }
    };
  }, [pathname, search]);

  const rememberAnchor = useCallback(
    (anchor: string) => storeAnchor(pathname, search, anchor),
    [pathname, search],
  );

  return { rememberAnchor };
}
