/**
 * Keyed in-memory cache for list reads that must survive a client-side route
 * change (CAR-256), plus the background refresh that keeps a written-to list
 * warm (CAR-278).
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
 * the accepted trade: the TTL, plus an explicit invalidation at the write sites
 * that change what a row displays.
 *
 * ── Invalidation REFRESHES; it does not merely delete (CAR-278) ──────────
 *
 * Note what that is not. `refreshList` never serves stale data while it works:
 * the entry is dropped first, so a read during the fetch is an ordinary miss.
 * What it changes is only what the cache holds AFTERWARDS. Deleting alone made
 * the moment the user was most likely to press Back — they just changed
 * something — the one moment the cache was guaranteed to miss, which inverts the
 * point of CAR-256.
 *
 * The refresher is throttled because the fetchers behind it are not cheap
 * (`getCompanies` is a paginated multi-query aggregate) and the write sites are
 * not rare (`use-pipeline-autosave.ts` invalidates on every save). Per key:
 * the first request runs immediately, further requests inside
 * `MIN_REFRESH_INTERVAL_MS` collapse into ONE trailing run, and a fetch already
 * in flight is joined rather than duplicated. A burst of N writes therefore
 * costs a couple of fetches instead of N, and the trailing run is what
 * guarantees the FINAL state gets fetched rather than an intermediate one.
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
 * Bumped every time a key is dropped. A refresh captures this before it fetches
 * and writes its result only if the number still matches, which is what stops a
 * fetch that STARTED before a write from landing after it and reinstating rows
 * the user's own action already contradicted.
 */
const versions = new Map<string, number>();

/** How long after a refresh starts before the same key may start another. */
export const MIN_REFRESH_INTERVAL_MS = 5_000;

interface Refresh {
  /** Rebuilt on every request, so it always closes over the newest inputs. */
  fetcher: () => Promise<unknown>;
  /** The fetch currently running, if any. */
  inflight?: Promise<unknown>;
  /** The version `inflight` was started against. */
  startedVersion: number;
  /** Epoch ms the last fetch STARTED. Drives the interval, not the completion time. */
  lastStartedAt: number;
  /** A request arrived while a fetch was running or the interval was still open. */
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Bookkeeping per refreshed key, kept even while idle: `lastStartedAt` is the
 * whole throttle, and discarding it between writes would let a steady drip of
 * saves start a fetch every time. Bounded by the number of query shapes one user
 * can open in one tab — five sorts, for the only caller that exists — so it does
 * not grow. Only `refreshList` ever creates an entry here; a delete-only caller
 * (`invalidateListsByPrefix`) leaves none behind.
 */
const refreshes = new Map<string, Refresh>();

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
    drop(key);
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
 *
 * Sweeps `listKeysByPrefix`, which includes keys that currently hold NO value
 * because a refresh is out fetching them. Skipping those would leave the fetch
 * unmarked, and it would write its pre-invalidation rows back afterwards —
 * undoing the invalidation from behind.
 */
export function invalidateListsByPrefix(prefix: string): void {
  for (const key of listKeysByPrefix(prefix)) drop(key);
}

/**
 * Every key under `prefix` this tab cares about: one that holds a value, or one
 * with a refresh running or pending.
 *
 * The second half is not redundant. Between a write and its refresh landing the
 * key has no ENTRY, so a `refreshes`-blind version of this would skip exactly
 * the keys a burst of writes is churning — and skipping a key means its in-
 * flight fetch is never marked stale, so a pre-write result gets written back as
 * if it were current.
 */
export function listKeysByPrefix(prefix: string): string[] {
  const keys = new Set<string>();
  for (const key of entries.keys()) if (key.startsWith(prefix)) keys.add(key);
  for (const key of refreshes.keys()) if (key.startsWith(prefix)) keys.add(key);
  return [...keys];
}

/**
 * Drop `key` and refetch it in the background, so the next read is a hit.
 *
 * Fire-and-forget by contract: a rejection is logged and leaves the key simply
 * absent, which the next read handles as an ordinary miss through the page's
 * own loading and error states. Nobody asked for this fetch and nobody is
 * looking at its result, so it must never surface an error or an unhandled
 * rejection.
 */
export function refreshList<T>(key: string, fetcher: () => Promise<T>): void {
  drop(key);

  const state: Refresh = refreshes.get(key) ?? {
    fetcher: fetcher as () => Promise<unknown>,
    startedVersion: -1,
    lastStartedAt: -Infinity,
    dirty: false,
  };
  state.fetcher = fetcher as () => Promise<unknown>;
  refreshes.set(key, state);

  // Busy, or already scheduled: mark and let the run that is coming pick it up.
  // Marking rather than queueing is what makes N writes cost one extra fetch.
  if (state.inflight !== undefined || state.timer !== undefined) {
    state.dirty = true;
    return;
  }

  const sinceLast = Date.now() - state.lastStartedAt;
  if (sinceLast < MIN_REFRESH_INTERVAL_MS) {
    state.dirty = true;
    schedule(key, state, MIN_REFRESH_INTERVAL_MS - sinceLast);
    return;
  }
  start(key, state);
}

/**
 * The background fetch already running for `key`, for a reader to await instead
 * of starting a second copy of the same query.
 *
 * `undefined` once the key has been dropped again since that fetch began: the
 * result is then known to predate a write, so a reader must go and get its own.
 */
export function inflightList<T>(key: string): Promise<T> | undefined {
  const state = refreshes.get(key);
  if (!state?.inflight) return undefined;
  if (state.startedVersion !== versionOf(key)) return undefined;
  return state.inflight as Promise<T>;
}

/**
 * Empty the cache and cancel every pending refresh. Test-only: module state is
 * shared across every test in a file, so without this a cached list leaks into
 * the next test and turns a suite order-dependent — and a live `setTimeout`
 * keeps the runner's event loop open.
 */
export function resetListCache(): void {
  entries.clear();
  versions.clear();
  for (const state of refreshes.values()) {
    if (state.timer !== undefined) clearTimeout(state.timer);
  }
  refreshes.clear();
}

function versionOf(key: string): number {
  return versions.get(key) ?? 0;
}

/** Forget `key`'s value and mark anything fetching it as out of date. */
function drop(key: string): void {
  entries.delete(key);
  versions.set(key, versionOf(key) + 1);
}

function schedule(key: string, state: Refresh, delayMs: number): void {
  if (state.timer !== undefined) return;
  const timer = setTimeout(() => {
    state.timer = undefined;
    if (refreshes.get(key) !== state) return;
    start(key, state);
  }, delayMs);
  // Never hold a test runner's event loop open for a background refresh. The
  // browser's setTimeout returns a number with no unref, hence the guard.
  (timer as unknown as { unref?: () => void }).unref?.();
  state.timer = timer;
}

function start(key: string, state: Refresh): void {
  state.dirty = false;
  state.lastStartedAt = Date.now();
  state.startedVersion = versionOf(key);

  const run = state.fetcher();
  state.inflight = run;

  void run
    .then((data) => {
      // Someone dropped the key after this fetch began, so its rows predate a
      // write. The `dirty` flag set by that same drop has already booked the
      // trailing run that will get it right.
      if (state.startedVersion === versionOf(key)) writeList(key, data);
    })
    .catch((err: unknown) => {
      console.error(`list-cache: background refresh failed for "${key}"`, err);
    })
    .finally(() => {
      // A newer run took over while this one was settling; it owns the state.
      if (state.inflight !== run) return;
      state.inflight = undefined;
      if (!state.dirty) return;
      const sinceStart = Date.now() - state.lastStartedAt;
      schedule(key, state, Math.max(0, MIN_REFRESH_INTERVAL_MS - sinceStart));
    });
}
