/**
 * Keyed in-memory cache for list reads that must survive a client-side route
 * change (CAR-256).
 *
 * A list page is a client component, so navigating into a detail page unmounts
 * it and its `useState` dies. Module scope does not: it outlives every mount in
 * the tab and is torn down only by a hard document load. That is exactly the
 * lifetime this cache wants — long enough to make "back" instant, short enough
 * that it cannot survive an account boundary, because `signOut`
 * (`src/components/auth-provider.tsx`) ends in a `hardNavigate`. This is the one
 * respect in which an in-memory cache differs from `use-suggestions.ts`, whose
 * localStorage cache genuinely does outlive a session and therefore has to treat
 * scope-keying as a security property rather than a correctness one.
 *
 * ── The cache is TRUSTED for its TTL ─────────────────────────────────────
 *
 * There is deliberately no stale-while-revalidate path here. A background
 * refresh would land reordered rows underneath a restored scroll position
 * (`use-scroll-restoration.ts`), moving the row the user was reading out from
 * under them — a worse failure than the staleness it fixes. Bounded staleness is
 * the accepted trade: the TTL, plus an explicit `invalidateListsByPrefix` at the
 * write sites that change what a row displays.
 *
 * Pure and React-free so it can be unit-tested in the node env, the same split
 * `company-filters.ts` uses.
 */

interface Entry {
  data: unknown;
  /** Epoch ms the entry was written. */
  at: number;
}

const entries = new Map<string, Entry>();

/**
 * The cached value for `key`, or `undefined` when absent or older than `ttlMs`.
 *
 * An expired entry is DELETED rather than merely skipped, so a key that stops
 * being read (a sort the user abandoned) cannot pin its rows in memory for the
 * life of the tab.
 *
 * `now` is injectable so the TTL can be tested without fake timers.
 */
export function readList<T>(key: string, ttlMs: number, now: number = Date.now()): T | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (now - entry.at > ttlMs) {
    entries.delete(key);
    return undefined;
  }
  return entry.data as T;
}

/** Store `data` under `key`, restamping its age. */
export function writeList<T>(key: string, data: T, now: number = Date.now()): void {
  entries.set(key, { data, at: now });
}

/**
 * Drop every entry whose key starts with `prefix`.
 *
 * Callers key by identity AND by query shape (`companies:<userId>:<sort>`), so a
 * write that changes what a row displays has to clear every shape at once — the
 * user may have been on any sort when they left, and invalidating only the
 * current one leaves the others to serve rows the write already contradicted.
 */
export function invalidateListsByPrefix(prefix: string): void {
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) entries.delete(key);
  }
}

/**
 * Empty the cache. Test-only: module state is shared across every test in a
 * file, so without this a cached list leaks into the next test and turns a
 * suite order-dependent.
 */
export function resetListCache(): void {
  entries.clear();
}
