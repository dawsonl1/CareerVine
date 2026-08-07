"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { consumePopNavigation, recallScroll, rememberScroll } from "@/lib/scroll-memory";

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
 *     reset it would be fixing.
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

export function useScrollRestoration({ pathname, search, ready }: UseScrollRestorationOptions): void {
  const wasPopRef = useRef(false);
  const restoredRef = useRef(false);

  // Read the pop signal once, at mount, rather than when `ready` turns true:
  // the signal expires, and the gap between the two is a fetch away in the
  // worst case. Declared first so it is set before the restore effect below
  // reads it on this same commit.
  useIsomorphicLayoutEffect(() => {
    wasPopRef.current = consumePopNavigation();
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (restoredRef.current || !ready || !wasPopRef.current) return;
    // One shot either way: if the conditions are met and we decline below, we
    // decline permanently rather than pouncing on a later render.
    restoredRef.current = true;
    // Next runs its own popstate restoration. When that one succeeds there is
    // nothing to fix, and re-applying a remembered value on top of it would
    // fight the framework for no gain.
    if (window.scrollY > 0) return;
    const y = recallScroll(pathname, search);
    if (y !== null && y > 0) window.scrollTo(0, y);
  }, [ready, pathname, search]);

  // Record the position continuously. rAF-throttled because `scroll` fires far
  // more often than sessionStorage should be written.
  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        rememberScroll(pathname, search, window.scrollY);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      // Catch a scroll that happened inside the last un-fired frame. Guarded on
      // a non-zero position deliberately: if Next has already scrolled the
      // outgoing page to the top by the time this cleanup runs, writing that 0
      // would erase the very position we are trying to keep.
      if (window.scrollY > 0) rememberScroll(pathname, search, window.scrollY);
    };
  }, [pathname, search]);
}
