import { useEffect, useMemo, useRef } from "react";

/**
 * Guards against out-of-order async results (CAR-145 / F19).
 *
 * Identity-keyed detail fetches (email provenance keyed by recipient, contact
 * autocomplete keyed by query, an email body keyed by message id) can resolve
 * in a different order than they were issued, letting a stale response overwrite
 * a newer one, e.g. a bounce banner attaching to a recipient the user already
 * changed away from. Claim a token with `begin()` when a request starts, then
 * gate any resulting state update behind `isLatest(token)` so only the most
 * recent request commits.
 *
 * The returned object is referentially stable, so it is safe in effect
 * dependency arrays. On unmount the token is bumped, which also drops any
 * in-flight resolver (preventing a setState on an unmounted component).
 *
 * ```ts
 * const req = useLatestRequest();
 * // ...
 * const token = req.begin();
 * const data = await fetchThing(id);
 * if (!req.isLatest(token)) return; // a newer request superseded this one
 * setThing(data);
 * ```
 */
export function useLatestRequest() {
  const tokenRef = useRef(0);

  useEffect(() => {
    return () => {
      // Invalidate every outstanding token so late resolvers skip their setState.
      tokenRef.current += 1;
    };
  }, []);

  return useMemo(
    () => ({
      /** Claim the newest token; call once when a request starts. */
      begin: () => {
        tokenRef.current += 1;
        return tokenRef.current;
      },
      /** True only if `token` is still the most recently claimed one. */
      isLatest: (token: number) => token === tokenRef.current,
    }),
    [],
  );
}

export type LatestRequest = ReturnType<typeof useLatestRequest>;
