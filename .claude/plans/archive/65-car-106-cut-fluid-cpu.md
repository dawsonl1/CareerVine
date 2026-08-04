# Plan 65 — CAR-106: Cut runaway Fluid Active CPU

## Why

Vercel Fluid Active CPU spiked Jul 8-12 (Jul 12 ≈ 31 min/day, a ~15 h/month run-rate against the Hobby plan's 4 h/month allowance). A 3-agent code audit + live QStash read found the spike is **not** baseline load — it's two fixable causes:

1. **Bundle-sync churn (the #1 consumer, ~4.5 min/12h).** A published bundle sitting `resolved_version < version` (documented live in CAR-81: `apm-data-bundle` v4 / resolved 0) disables fast-apply and forces every sync onto the ~97s merge path. Two amplifiers on top:
   - `sync-bundles` cron times out at `maxDuration=60s` because a single `resolveBundleChunk` (200 rows, hundreds of sequential find-or-create round-trips on a cold cache) is unbounded — the 12s resolve budget is only checked *between* chunks. Vercel hard-kills → 100% error → QStash retries 3× (1 fire + 3 = the observed 4 invocations/12h).
   - `bundle-sync` worker throws (merge-path linkage/removal failures) propagate as 500s (no try/catch in the route; processor uses try/finally) → QStash retries each 3× → the observed 22.5% error rate amplifies invocations.

2. **Home page transitively polls the calendar every 5 min, even on hidden tabs (the per-user scaling term).** `page.tsx`'s 5-min `loadCoreData` refresh sets a new `contactHealth` ref → new `lastTouchLookup` memo → new `loadSchedule` identity → its effect re-fires → `POST /api/calendar/sync` + `GET /api/calendar/events`. No visibility guard. ~24 calendar calls/hr per open tab; scales linearly with concurrent tabs.

Deploys/builds don't count toward this metric — this is all function runtime.

## Fixes (one PR)

### Fix 1 — bound the resolver chunk (`bundle-resolve.ts`, `sync-bundles/route.ts`)
- Add an optional `deadline` to `resolveBundleChunk` opts. In Pass 1 (the per-prospect find-or-create loop), stop before starting another prospect once `Date.now() >= deadline` — but **always process ≥1 prospect** so the resume cursor advances (no infinite drain). Run Pass 2 + the RPC only for the processed subset; return `nextAfterId = lastProcessed.id`, `done=false` when stopped early. Deadline-less callers behave exactly as before (backwards compatible).
- `resolveStaleBundles` passes its existing 12s `deadline` down to each chunk. Result: the resolve phase yields at ~12-14s instead of running a cold chunk past 60s; the CAR-81 self-drain re-enqueues to continue. `sync-bundles` stops timing out → stops the 100% error + retries.

### Fix 2 — worker resilience (`bundle-queue.ts`, `queue/bundle-sync/route.ts`)
- Wrap the per-subscription body of `processSubscriptionsUnderBudget` in try/catch. On throw: log, push the id to a new `failed[]` bucket, continue to the next subscription. Claims are already released in the inner `finally`, so no zombie claims.
- `failed` is **not** re-enqueued (unlike `remaining`) — a deterministically-broken subscription drops out of the hot queue and gets a fresh chance on the next daily stale-scan, instead of hot-looping. The worker returns 200 with a `failed` count instead of a 500 QStash retries 3×.

### Fix 3 — stop the hidden-tab calendar poll (`page.tsx`)
- Read `lastTouchLookup` through a ref inside `loadSchedule` and drop it from the callback deps, so a core-data refresh no longer changes `loadSchedule`'s identity and no longer cascades into a calendar sync. `loadSchedule` then re-fires only on `user` / `calendarConnected` / `gmailLoading` changes (the genuine triggers). Minor accepted tradeoff: last-touch labels on today's meetings refresh on the next calendar load, not on every data refresh.
- Gate the 5-min background interval on `document.visibilityState === "visible"`; add a `visibilitychange` refresh so returning to a backgrounded tab still gets fresh data. Hidden tabs stop polling entirely.

## Tests
- `bundle-resolve.test.ts`: chunk with a past deadline processes exactly 1 prospect, returns `done=false` + `nextAfterId` = first row id; without a deadline, unchanged behavior.
- `bundle-queue.test.ts`: a subscription whose `apply` throws lands in `failed` (not `remaining`/`completed`), the function does not throw, and later subscriptions still process.
- `npm run test` + `npm run build` from `careervine/`.

## Verify before finalizing
- Confirm the `sync-bundles` failure is the timeout (not a signature 401). The QStash destination is already `https://www.careervine.app/...` (www, so rule 29's apex→www issue doesn't apply); ~6.75s Active CPU/invocation already argues timeout over a fast 401. Peek at Vercel function logs if available.
- Post-merge: watch the Fluid Active CPU daily chart fall back toward baseline.
