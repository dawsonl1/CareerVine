# CAR-81 — Published bundles can sit unresolved for days → onboarding stuck on merge path

## Root cause (confirmed live, 2026-07-11)

- Fast path gates on `resolved_version === version`. Production apm-data-bundle was
  `version 4 / resolved_version 0`, 400/2000 prospects resolved → every signup took
  the 97s merge path (proven by CAR-78 telemetry: `path:"merge", 96874ms`).
- Publish resolve stopped at 400/2000 and was swallowed ("cron will finish it").
- The self-heal cron (`resolveStaleBundles`) restarts at `afterId=0` each daily run,
  re-scanning resolved rows under a 12s budget → ~1 chunk of net progress/day,
  ~10 days to recover a 2,000-row bundle. Confirmed by firing it: 200 OK, +200/run.
- The re-scan can't be DB-filtered today because a payload change at publish
  (`bundle-publish.ts:244`) rewrites `payload_hash` but leaves stale `resolved`.

Live bundle already driven to `resolved_version 4` in-session (ops). This plan
prevents recurrence.

## Changes

### 1. `bundle-publish.ts` — invalidate resolution on payload change
In `publishProspectsChunk`, the payload-change branch (the `.update({ payload, … })`)
adds `resolved: null`. New inserts already omit `resolved` (null). After this,
`resolved IS NULL` is an exact "needs (re)resolution" predicate.

### 2. `bundle-resolve.ts` — DB-filter the scan to unresolved rows
`resolveBundleChunk`'s query gains `.is("resolved", null)`. Every budget-second now
resolves NEW rows instead of skip-scanning done ones → linear, not O(n²). The JS
`readProspectResolution` hash check stays (belt-and-suspenders; a row that is
non-null but somehow stale is simply not re-fetched now — acceptable because #1
guarantees changed rows are nulled). `markBundleResolved` still only fires when the
scan returns zero rows, which now means zero unresolved rows.

### 3. `api/cron/sync-bundles` — self-drain instead of daily drip
`resolveStaleBundles` returns whether it made forward progress AND whether any bundle
is still `resolved_version < version`. The route, after resolve+sync, re-enqueues one
more `sync-bundles` run (short QStash delay, e.g. 5s) **only when progress was made
and a bundle is still behind**. A backlog drains in minutes and self-terminates;
zero-progress (genuinely stuck bundle) does NOT re-enqueue → no infinite loop.
Reuses the QStash enqueue the route already does for subscriber fan-out.

## Tests
- publish: changed payload → update payload carries `resolved: null`; unchanged/added
  paths untouched.
- resolve: scan query includes `is("resolved", null)`; already-resolved rows aren't
  fetched (mock asserts the filter).
- cron: re-enqueues when `progress && stillBehind`; does NOT when `!progress`; does NOT
  when fully caught up.

## Verification
`npm run test` + `npm run build` from careervine/. Migration: none.
Docs: none (internal reliability; no user-facing surface changes).
