# CAR-112 — Bundle-sync worker 60s timeout: align budget + hard backstop

## Problem (confirmed from prod)

`/api/queue/bundle-sync` shows 100% error rate — every recent run hits
`Vercel Runtime Timeout Error: Task timed out after 60 seconds` (4/4 in 24h,
last 2026-07-13 12:37 UTC, ~37 min after the daily `sync-bundles` fan-out).
Over 7d the same signature fired 363× across the import pipeline; CAR-106
(07-12) bounded the resolver and cut it to a trickle — `bundle-sync` is the
residual CAR-106 didn't close.

### Root cause

`processSubscriptionsUnderBudget` (`src/lib/bundle-queue.ts`) checks its
wall-clock deadline **only between chunks** — the budget gates *starting* a
step, never interrupts one. The worker calls it with **no budget arg**, so it
inherits the default `SYNC_BUDGET_MS = 45_000`. Under `maxDuration = 60` that
is a **15s margin** — smaller than the pipeline's own documented worst-case
`applyBundleDelta` step. `/api/bundles/apply` deliberately uses `35_000`
(**25s margin**) with a CAR-78 comment: the margin "must absorb one worst-case
step". A 150-prospect merge chunk (importPeopleChunk + up to 150 sequential
per-row UPDATEs + 2× fetchTouchSignals, worse on stale resolution) that starts
near the 45s mark runs past 60s. `/api/admin/users/[id]/contacts` shares the
flaw (also default budget).

### Blast radius

Mid-chunk hard-kill ⇒ the handler's graceful `remaining`/`requeued` re-enqueue
never runs ⇒ QStash retries the whole 10-sub batch 3× (Active-CPU + quota
amplification — the CAR-106 failure mode). Receipt: QStash 1000/day quota was
exhausted 07-12 (`QstashDailyRatelimitError` ×11).

## Design

Two layers, one source of truth. All timing constants derive from
`maxDuration = 60s`:

| constant | value | meaning |
| --- | --- | --- |
| `FUNCTION_MAX_MS` | 60_000 | mirrors `maxDuration` (doc anchor) |
| `SYNC_STEP_RESERVE_MS` | 25_000 | worst-case single `applyBundleDelta` step (CAR-78) |
| `SYNC_BUDGET_MS` | 35_000 | = MAX − RESERVE. Stop *starting* new steps here |
| `SYNC_RESPONSE_DEADLINE_MS` | 55_000 | hard backstop; handler must have responded by here (5s to serialize + re-enqueue before the kill) |

1. **Align the default margin (the fix).** Lower `SYNC_BUDGET_MS` 45_000 →
   35_000. The worker and the admin route both use the default, so both get the
   apply route's proven-safe 25s margin for free. The cron passes an explicit
   `remainingMs`, unaffected. Cooperative path stays precise (returns exact
   `remaining`).

2. **Hard backstop (the guarantee).** New `src/lib/time-budget.ts`:
   `runWithResponseDeadline(msFromNow, work, onDeadline)` races `work` against a
   wall-clock timer. Because every step is an `await`ed DB call, the timer fires
   on the event loop even while a step is pending. On deadline the abandoned
   `work` promise keeps running until Vercel freezes the function — safe because
   the sync is idempotent + checkpoint-resumed (CAR-54). Guarantees a response
   before 60s no matter how slow one step is.
   - **Worker:** on backstop, re-enqueue the whole input batch (idempotent;
     completed subs no-op next run) and return 200 `{ timedOut: true }`.
     Converts a 60s hard-kill (→ 3× QStash batch retry) into one clean
     re-enqueue.
   - **Cron direct-sync path** (no-queue fallback only): on backstop, return the
     partial result; stale subs are picked up next daily run. (Can't re-enqueue
     — this path runs precisely when QStash is down.)

3. **Unify the apply route's constant.** Replace the local
   `APPLY_LOOP_BUDGET_MS = 35_000` literal with the shared `SYNC_BUDGET_MS`
   (identical value → zero behavior change) so there's one number to reason
   about. **No control-flow change** — the apply loop is already safe and is the
   hot onboarding path; adding a backstop there could trade a rare timeout for a
   rare claim-TTL stall mid-onboarding. Out of scope by design.

## Non-goals

- **No** `maxDuration` bump (fights CAR-106; a longer CPU-bound run is worse
  than a kill on the 4-hr/mo Active-CPU budget).
- **No** `SYNC_CHUNK_SIZE` reduction (fights CAR-57; more QStash messages
  against the quota we already blew).

## Files

- `src/lib/time-budget.ts` — **new** helper + doc.
- `src/lib/bundle-queue.ts` — `SYNC_BUDGET_MS` 45_000 → 35_000 (+ derivation
  comment, `SYNC_RESPONSE_DEADLINE_MS` export).
- `src/app/api/queue/bundle-sync/route.ts` — wrap processing in the backstop;
  re-enqueue whole batch on deadline.
- `src/app/api/cron/sync-bundles/route.ts` — wrap the direct-sync fallback in
  the backstop; align the RESOLVE/JOB budget comment.
- `src/app/api/bundles/apply/route.ts` — import shared `SYNC_BUDGET_MS`.

## Tests (`npm run test`, `npm run build` from `careervine/`)

- `time-budget.test.ts` — work-wins-before-deadline returns the value; timer
  wins → `onDeadline` result; clears the timer (no leak); `onDeadline` async.
- `bundle-queue.test.ts` — assert the exported `SYNC_BUDGET_MS === 35_000` and
  the default-arg path uses it (a tight injected clock returns everything as
  `remaining`).
- Worker route test (**new**) — backstop path re-enqueues the input batch and
  returns 200 `{ timedOut: true }`; happy path unchanged.
- Existing `sync-bundles-cron.test.ts` — stays green (mocked processor resolves
  immediately, so the backstop never fires).

No migration. No user-facing copy change (backend reliability only; docs page
unaffected — verify per rule 34).
