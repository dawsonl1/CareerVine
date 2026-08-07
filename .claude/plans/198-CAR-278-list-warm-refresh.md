# CAR-278 — Companies list: 15-minute cache, warm refresh after a write, anchor-based scroll return

Follow-on to CAR-256 (list cache + scroll restoration) and CAR-268 (the same for the company detail page).

## The problem

`invalidateCompaniesList` currently only **deletes**. Every write that contradicts a row — a tier move, a company delete, any pipeline autosave — leaves the cache empty, so the next return trip pays a full `getCompanies` aggregate. That inverts the intent of CAR-256: the moment the user is *most* likely to press Back (they just changed something) is the moment the cache is guaranteed to miss.

Three changes, in dependency order.

---

## 1. TTL 5 min → 15 min

`COMPANIES_LIST_TTL_MS` in `src/lib/companies-list-cache.ts`.

The write sites already invalidate precisely, so the TTL is not the mechanism that keeps the list correct — it is only the outer bound for changes this tab cannot observe (a cron, MCP, another tab, an edit made from a surface other than the company detail page). Tripling it triples that blind window and nothing else.

Its doc comment claims the value "matches the home page's SWR window (`src/app/page.tsx`)". That stops being true, so the comment changes with the number rather than being left to rot.

Two other comments quote the old figure and must move together:
- `src/app/companies/[id]/page.tsx` — "the company sits in the 5-minute cache".
- Anything else `grep -rn "5-minute\|5 minute"` turns up under `src/`.

---

## 2. Invalidation becomes a warm refresh

### Shape

`list-cache.ts` gains a refresh layer over the existing `Map`. The store stays pure and React-free, which is what lets it be unit-tested in the node env.

```ts
export function refreshList<T>(key: string, fetcher: () => Promise<T>): void
export function inflightList<T>(key: string): Promise<T> | undefined
```

`refreshList` deletes the entry immediately (so nothing contradicted is ever served, exactly as today), then fetches and writes the result back.

### Throttling is mandatory, not a nicety

`getCompanies` is a paginated multi-query aggregate with an enrichment fan-out, and `use-pipeline-autosave.ts` invalidates on **every** save — twice, in `flush()` and in the enqueued path. An un-throttled refresh would fire that aggregate on every keystroke-debounce of a note. So, per key:

- **Leading edge runs immediately.** The common case is one write then a return trip; delaying it would waste the only window that matters.
- **In-flight requests are deduplicated.** A second `refreshList` during a fetch sets a dirty flag instead of starting a parallel aggregate.
- **A dirty key always gets a trailing run**, scheduled at `MIN_REFRESH_INTERVAL_MS` after the last one settled. This is what guarantees the *final* state is fetched rather than an intermediate one — the property a plain debounce cannot give.

`MIN_REFRESH_INTERVAL_MS = 5000`. An editing session of N saves costs roughly `1 + duration/5s` aggregates rather than N.

### Joining, not racing

`useCachedList` currently does: cache hit → done, else fetch. It gains a middle rung: on a miss, if `inflightList(key)` returns a promise, await that instead of calling `fetcher`. Without this, pressing Back one second after a stage change starts a *second* copy of a multi-second aggregate that is already running.

The joined path still goes through `useLatestRequest`, still writes through `writeList`, and still reports `fromCache: false` — the user did wait, so scroll restoration correctly declines (see §3).

### Failure semantics

A refresh rejection is logged and swallowed: the entry is simply absent and the next read is an ordinary cache miss with the page's normal loading and error states. A background fetch must never surface an unhandled rejection or a user-visible error, because the user did not ask for it and is not looking at the list.

### Test hygiene

`resetListCache()` must also clear pending timers, in-flight promises and dirty flags. Module state that outlives a test is how a suite becomes order-dependent, and a live `setTimeout` is how Vitest hangs.

### Call sites

`invalidateCompaniesList(userId)` becomes `refreshCompaniesList(userId)`: for each cached sort under the prefix, delete and schedule. It needs to know which sorts were cached, so `list-cache.ts` also exports `listKeysByPrefix(prefix)`.

Only sorts that were **already cached** are refreshed. Warming a sort the user has never opened would be inventing work.

The fetcher cannot live in the page (the page is unmounted at every write site — that is the premise of the whole module), so `companies-list-cache.ts` imports `getCompanies` directly and rebuilds the call from the key. That means the key's sort has to be recoverable from the key, which it is.

**`invalidateCompanyScopes()` is not given the same treatment.** Its write sites fire while the detail page is mounted and holding its own state, and its key set spans every company the user has visited. Refreshing all of them on a tier change would be a large amount of speculative work for a page the user is already on.

---

## 3. Anchor-based scroll return

### Why the pixel offset alone stops being enough

A warm-refreshed list can be **reordered or shorter** than the one the user left — that is the entire point of refreshing it. The default sort is "What's next", which is exactly the ordering a stage change perturbs. A remembered pixel offset then lands on whatever row now occupies that height.

### Storage

`scroll-memory.ts`'s `StoredEntry` becomes `[search, y, anchor?]`. The validator relaxes from `length === 2` to `length >= 2` so entries written by the shipped version keep working rather than being discarded — sessionStorage survives the deploy.

New: `rememberAnchor(pathname, search, anchor)` writes the third slot without disturbing `y`, and `recallAnchor(pathname, search)` reads it. Separate from `rememberScroll` because they are written by different events at different times: `y` continuously by the scroll listener, the anchor once on the click that navigates away.

### Restoration order

In `use-scroll-restoration.ts`, after the existing `y` restore:

1. Apply `y` (unchanged — pixel-perfect when nothing moved).
2. If an anchor was remembered, look for `[data-scroll-anchor="<id>"]`.
3. If it is found and **not already in the viewport**, `scrollIntoView({ block: "center" })`.

Offset-first is deliberate. When the list did not change, step 3 finds the row already on screen and does nothing, so the user gets the exact position they left rather than a re-centred approximation. The anchor is a *rescue*, not the primary mechanism. When the row is gone entirely (deleted, or filtered out), `y` stands.

### Wiring

- `useScrollRestoration` returns `{ rememberAnchor }`.
- `CompanyCard` takes an optional `onNavigate?: () => void` and calls it from the `Link`'s `onClick`, plus renders `data-scroll-anchor={c.id}` on its root.
- The companies page passes `onNavigate={() => rememberAnchor(String(c.id))}`.

`data-scroll-anchor` rather than `id` so it cannot collide with anything else in the document and reads as what it is.

### Boundary that stays

Restoration is still gated on `ready: fromCache`. Landing the user mid-list after they sat through a real fetch remains out of scope — CAR-256 argued that case and nothing here changes it. What changes is how often `fromCache` is true, which is the actual fix.

---

## Verification

- Unit: `list-cache.test.ts` (leading run, in-flight dedup, dirty trailing run, rejection is inert, reset clears timers), `use-cached-list.test.tsx` (joins in-flight rather than double-fetching), `scroll-memory.test.ts` (anchor round-trip, 2-element back-compat), `use-scroll-restoration.test.tsx` (offset wins when the row is visible, anchor rescues when it is not, missing anchor falls back).
- `npm run test` with the coverage gate, `npm run check:conventions`, `npm run test:integration`, `npx playwright test`, `npm run build`.
- E2E: extend `companies-back-nav.spec.ts` — after a write invalidates, the return trip must not refetch.
- Falsify every new test by reverting the behaviour it claims to cover and confirming it goes red.
