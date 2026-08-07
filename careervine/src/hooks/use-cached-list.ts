"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { inflightList, readList, writeList } from "@/lib/list-cache";

/**
 * A list read that survives back-navigation (CAR-256).
 *
 * Wraps the `useEffect` + `load()` + `useState` shape every list page in this
 * app uses, adding the one thing that shape cannot have: a result that outlives
 * the unmount. See `src/lib/list-cache.ts` for why the store is in-memory, why
 * nothing stale is ever served while a refetch runs, and how a write refreshes
 * the cache from outside any mounted component.
 *
 * ── Hydration happens in the state INITIALIZER, on purpose ───────────────
 *
 * Not in an effect. Scroll restoration needs the document to already have its
 * real height on the commit the browser paints, and a list populated one render
 * later is a list that was one viewport tall at the moment restoration ran.
 *
 * In practice the first render still misses, because `AuthProvider` resolves the
 * session asynchronously and a `user.id`-keyed caller therefore passes
 * `key: null` on mount. That is why the cache-hit path below runs in a LAYOUT
 * effect: a `setState` from a passive effect permits a paint in between, which
 * is the flash-at-top this hook exists to avoid. `getSession()` reads
 * localStorage before the network, so the gap is a render, not a round trip.
 *
 * Failure semantics match what the companies page established in CAR-205: a
 * throw never clears `data`, so a failed REFRESH still has a valid list to show
 * under a banner, and only a failure with nothing loaded is a full error state.
 */

// `useLayoutEffect` has no meaning during SSR and React warns about it there.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface UseCachedListOptions<T> {
  /**
   * Cache identity. Must encode everything `fetcher` reads — the user and any
   * server-side sort or scope — because a changed key is the ONLY signal that
   * refetches. `null` means "not ready yet" (no user): no read, no write.
   */
  key: string | null;
  ttlMs: number;
  fetcher: () => Promise<T>;
  /** Value shown before anything has loaded. Should be referentially stable. */
  fallback: T;
}

export interface CachedList<T> {
  data: T;
  loading: boolean;
  /** A read failed. `data` is whatever the last success left, never cleared. */
  failed: boolean;
  /**
   * The data on screen came from the cache rather than a fetch. This is the
   * scroll-restoration gate: true means the list is at full height right now.
   */
  fromCache: boolean;
  /** Force a fetch, bypassing the cache. For an explicit Retry. */
  reload: () => void;
}

export function useCachedList<T>({
  key,
  ttlMs,
  fetcher,
  fallback,
}: UseCachedListOptions<T>): CachedList<T> {
  // One cache probe, reused by the three initializers below. Lazy state rather
  // than a ref because a ref may not be read during render, and this value is
  // needed at exactly that moment: it decides the first painted commit.
  const [initial] = useState(() => {
    const cached = key === null ? undefined : readList<T>(key, ttlMs);
    return { data: cached ?? fallback, hit: cached !== undefined };
  });

  const [data, setData] = useState<T>(initial.data);
  const [fromCache, setFromCache] = useState(initial.hit);
  const [loading, setLoading] = useState(!initial.hit);
  const [failed, setFailed] = useState(false);

  const request = useLatestRequest();

  // Latest-callback ref rather than a dependency. A caller who forgets to
  // memoize `fetcher` would otherwise get a new `run` every render and an
  // infinite refetch loop — an unacceptable trap in something meant to be
  // adopted by five more pages. Declared BEFORE the effect that reads it:
  // effects of one commit run in declaration order, so the ref is current.
  const fetcherRef = useRef(fetcher);
  useIsomorphicLayoutEffect(() => {
    fetcherRef.current = fetcher;
  });

  const run = useCallback(
    (force: boolean) => {
      if (key === null) return;
      if (!force) {
        const cached = readList<T>(key, ttlMs);
        if (cached !== undefined) {
          setData(cached);
          setFromCache(true);
          setLoading(false);
          setFailed(false);
          return;
        }
      }
      // Two reads genuinely overlap here: the sort control stays enabled while
      // one is in flight, so the key can change mid-request. Ungated, a stale
      // REJECTION landing after a newer success sets `failed` with nothing left
      // to clear it, and the page shows an error banner over a correct list
      // until the user hits Retry (CAR-205).
      const token = request.begin();
      setFromCache(false);
      setLoading(true);
      setFailed(false);
      // A write on a detail page starts a background refresh of this exact key
      // (CAR-278), and pressing Back lands here while it is still running.
      // Joining it beats issuing a second copy of a query that is already in
      // flight — for `getCompanies` that is a paginated multi-query aggregate.
      // `inflightList` returns nothing once its fetch is known to predate a
      // write, so joining can never adopt a result the cache itself rejected.
      const joined = force ? undefined : inflightList<T>(key);
      void (joined ?? fetcherRef.current())
        .then((result) => {
          if (!request.isLatest(token)) return;
          // A joined fetch writes its own result through `refreshList`, under a
          // staleness check this hook cannot see. Writing it again here would
          // reinstate rows that check may have just refused.
          if (!joined) writeList(key, result);
          setData(result);
          setLoading(false);
        })
        .catch((e) => {
          if (!request.isLatest(token)) return;
          console.error(`useCachedList: read failed for "${key}"`, e);
          // `data` is intentionally left alone — see the header.
          setFailed(true);
          setLoading(false);
        });
    },
    [key, ttlMs, request],
  );

  useIsomorphicLayoutEffect(() => {
    run(false);
  }, [run]);

  const reload = useCallback(() => run(true), [run]);

  return { data, loading, failed, fromCache, reload };
}
