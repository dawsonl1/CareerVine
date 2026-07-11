# CAR-78 — Bundle sync speedups: RLS initplan wrap, server-side apply loop, deferred analytics, path instrumentation

## Context

Post-CAR-62 the onboarding bundle sync still takes ~2 minutes. Audit (2026-07-11)
found four compounding costs that need no architectural change. Companion ticket
CAR-77 reworks the onboarding UX on top of this.

## Changes

### 1. RLS initplan migration — `20260711160000_rls_initplan_wrap.sql`

Recreate the hot-path policies with `(SELECT auth.uid())` so Postgres evaluates
the uid once per statement instead of per row (Supabase `auth_rls_initplan` lint).
Tables: `contacts`, `contact_companies`, `contact_emails`, `contact_schools`,
`contact_tags`, `tags`, `bundle_subscriptions`, `bundle_subscription_contacts`,
`bundle_contact_state`, `suppressed_imports`. `DROP POLICY` + `CREATE POLICY`
with byte-identical predicates except the wrap. Semantics unchanged.

Validation: rule-32 BEGIN/`SET LOCAL lock_timeout='3s'`/apply/ROLLBACK against
production before `supabase db push`. Must account for later migrations that
touched these tables' policies (grep all migrations per table before writing).

### 2. Server-side loop in `/api/bundles/apply`

After `claimSubscriptionSync`, iterate `applyBundleDelta` steps in-process under
a wall-clock budget (`APPLY_LOOP_BUDGET_MS = 45_000`, `maxDuration = 60` slack),
CAS-renewing the claim between steps (`claimSubscriptionSync(supabase, id, token)`).
Stop when: done, budget exhausted, or claim renewal fails. Response contract
unchanged (`done | nextCursor | pinnedVersion | applied (summed) | claimToken`),
so the browser loop, QStash worker, cron, and Settings need no changes — they
just see 1–2 round trips instead of ~14. `applied` sums across inner steps so
client progress totals stay correct.

### 3. Deferred analytics off the critical path

- `runFastApplyStep`: `trackServer("contact_imported")` becomes fire-and-forget
  via a collected promise returned to the route (or awaited post-loop) — the
  route pushes it into the api-handler's `pendingTracks` via `ctx.track` shape.
  Simplest concrete mechanism: `applyBundleDelta` gains
  `opts.deferAnalytics?: (p: Promise<void>) => void`; when provided, analytics
  promises are handed to it instead of awaited. Apply route passes a collector
  wired to the handler's `pendingTracks` (exposed as `ctx.defer(promise)` — add
  a tiny `defer` to withApiHandler context mirroring `track`). Worker/cron omit
  it → current awaited behavior, unchanged.
- `checkContactMilestone`: fast path already runs it only at commit; on the
  merge path, stop passing `analyticsSource` per-chunk emission burden — keep
  the per-chunk `contact_imported` event (it carries counts) but deferred, and
  move `checkContactMilestone` to the sync-commit point in `applyBundleDelta`.

### 4. Path instrumentation

- `ApplyStepResult` gains `path: "fast" | "merge"`.
- Route response already returns the step → client picks it up; the onboarding
  flow includes `path` + `duration_ms` in `onboarding_sync_completed`.
- Server: `contact_imported` (bundle source) gains optional `fast: boolean`.
- `AnalyticsEvents` typings updated accordingly.

### 5. Parallel fast-path contact inserts

`runFastApplyStep`'s contacts loop over 500-row batches is sequential; each
batch maps RETURNING independently → `Promise.all` over `chunkList(pending, 500)`.

## Tests

- Migration: no unit test (rule-32 rollback validation at apply time); grep-based
  consistency check that every wrapped policy name matches a dropped one.
- Apply-route loop: unit test that a multi-chunk sync completes in one handler
  call under a large budget, and that budget exhaustion returns a cursor +
  claimToken (mock applyBundleDelta steps).
- Deferred analytics: test that apply route defers (no await ordering
  dependency) and worker path still awaits.
- Path field: bundle-fast-apply + bundle-sync tests assert `path` on results.
- Existing suites (`bundle-sync`, `bundle-fast-apply`, `bundle-queue`,
  `bundle-subscribe-route`) must stay green; update stale expectations.

## Verification

`npm run test` + `npm run build` from `careervine/`. Migration validated via
rule-32 rolled-back production apply before push (post-merge).

## Docs

docs.careervine.app: "Resilient apply loop" card still accurate (chunked,
cursor-driven, QStash/cron safety net) — no copy change needed for CAR-78;
CAR-77 owns the onboarding step copy.
