# CAR-256 — Companies page keeps its list, scroll, and filters across back-navigation

Going into a company and coming back costs a full refetch, drops you at the top,
and (on the in-app back button) throws away every filter. Three separate causes,
three fixes, built so the other list pages can adopt them.

## Decisions taken before writing code

**Trust the cache for its TTL — no background revalidation.** A silent refresh
would land fresh rows under a restored scroll position and reorder the list
(`sort: "next"` is derived from traction, so order genuinely moves), leaving the
user looking at a different company than the one they were reading. Staleness is
bounded instead by an explicit invalidation on the writes that change what a
company card shows.

**In-memory module store, not localStorage.** The home page's SWR cache
(`src/app/page.tsx:83`) caches three small lists; an enriched `CompanySummary[]`
over an in-play set is far heavier, against a 5 MB origin quota, and would pay
JSON serialization on every write. Module scope survives client-side route
changes, which is exactly the lifetime the complaint is about. It dies on hard
refresh and tab close, which is fine.

**No sign-out wiring needed.** `auth-provider.tsx:197` `signOut` ends in
`hardNavigate("/")`, a full document load, so module state is already wiped at
the account boundary. This is why in-memory keying differs from
`use-suggestions.ts`, whose localStorage cache genuinely does outlive a session
and therefore treats scope-keying as load-bearing.

**Hydration lands on the second render, not the first, and that is fine.**
`AuthProvider` resolves the session asynchronously, so `user` is null on every
first render and a `user.id`-keyed cache cannot hydrate before it. `getSession()`
reads localStorage first, so the gap is a few ms, and the scroll restore runs in
a `useLayoutEffect` — before the browser paints the hydrated commit. No flash,
and no need to weaken the key to dodge the auth gate.

## A. Back button (`src/app/companies/[id]/page.tsx:249`)

Replace `<Link href="/companies">` with the pattern `contacts/[id]/page.tsx:410`
already uses: `hasInAppBackHistory() ? router.back() : router.push("/companies")`,
from `src/lib/nav-history.ts`.

`router.back()` returns to the exact history entry, so the filters come back for
free, and it makes the return a popstate rather than a forward push — which is
what lets scroll restoration engage at all.

**Relabelled "Back", not "Companies."** `router.back()` legitimately returns to
wherever you came from, which may be `/outreach`. A button labelled "Companies"
that lands on outreach is a lie; the contacts page already made this call.

## B. Cached list

- `src/lib/list-cache.ts` — pure, no React, unit-testable in the node env like
  `company-filters.ts`. A keyed `Map` of `{ data, at }`, with `readList`,
  `writeList`, `invalidateListsByPrefix(prefix)`, and `resetListCache()`.
- `src/hooks/use-cached-list.ts` — the React binding.
  `useCachedList({ key, ttlMs, fetcher, fallback })` →
  `{ data, loading, failed, hydratedFromCache, reload }`.
  - `key === null` (no user yet): stays loading, never reads or writes.
  - fresh cache entry: hydrates in the `useState` initializer, `loading` false,
    **no fetch issued**.
  - stale or absent: fetches, keeping the previous `data` rather than clearing
    it, so the existing "stale list + banner" vs "full error" split at
    `companies/page.tsx:132` keeps working unchanged.
  - gates its commit on `useLatestRequest`, preserving the CAR-205 fix where a
    stale *rejection* landing after a newer success set `loadFailed` with
    nothing left to clear it.
- `src/lib/companies-list-cache.ts` — `companiesListKey(userId, sort)`,
  `invalidateCompaniesList(userId)` (prefix-invalidates every sort).

**Invalidation is called at the write site, not over the `ui-events` bus.** The
bus coordinates *mounted* views; here the companies list is unmounted by
definition — the user is on the detail page. The two writes that change a
company card are `usePipelineAutosave` (its header states it mirrors cycle stage
onto `target_companies.status` "so list views stay accurate") and the tier moves
at `companies/[id]/page.tsx:155-157` (`activateContact` /
`promoteContactToProspect` / `demoteContactToBench`, which move the
current/former/bench counts, traction, and lead name).

## C. Scroll restoration

- `src/lib/scroll-memory.ts` — pure. A bounded per-pathname map in
  sessionStorage under `cv:scroll:<pathname>` (joining the `cv:*` namespace
  `nav-history.ts` established), keyed inside by the full search string so a
  differently-filtered list gets its own position, LRU-capped so typing in the
  search box cannot grow it without bound.
- `src/hooks/use-scroll-restoration.ts` — throttled `scroll` listener writes the
  position; a `useLayoutEffect` restores it when told the content is ready.

Restores **only** when the list hydrated synchronously from cache, so the
document already has its full height. On a genuine refetch there is nothing to
restore to and jumping the user after a wait would be worse than leaving them at
the top.

Guarded against fighting Next's own popstate restoration: skip if `scrollY` is
already non-zero, so a correct native restore is never overridden.

## Verification

- Unit: `list-cache` (TTL expiry, prefix invalidation), `scroll-memory` (LRU cap,
  per-search keying), and a companies-page test that a warm cache renders rows
  with no fetch.
- `companies-page-load-failure.test.tsx` must still pass — a cold cache is
  today's behavior exactly. Confirm the reset runs between tests or the module
  cache leaks across them.
- E2E: back-navigation keeps rows, position, and filters. This is the part that
  cannot be proven in jsdom.
- `e2e/request-budget.spec.ts` — the `/companies` ceiling should fall on a warm
  load, not rise. Run it and adjust in this PR if it moves.
- `npm run test`, `npm run test:integration`, `npm run check:conventions`,
  `npm run build`.

## Scope boundary

The primitives are built reusable; only `/companies` adopts them here. Contacts,
meetings, outreach, and calendar have the identical fetch-on-mount shape and are
follow-on adoptions, each needing its own invalidation audit.

## What this does not fix

A cold load, a hard refresh, and any TTL miss still pay the full four-wave
client-side read. This hides that cost on the return trip rather than removing
it; the structural fix is a server-side read, blocked on `db()`
(`company-queries.ts:58`) being a browser singleton whose injection seam
(`setCompanyQueriesClient`) is a module global and therefore unsafe under
concurrent server requests.
