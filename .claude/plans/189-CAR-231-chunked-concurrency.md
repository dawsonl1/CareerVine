# CAR-231 — bounded-concurrency chunk reads

Measurements and acceptance live in the Linear issue. This file is the execution plan.

## The shape of the problem

`chunked()` and `chunkedPaginated()` both walk their id chunks with an `await` inside a
plain loop, so each caller is serial in `ceil(ids.length / chunkSize)`. `getContactStages`
runs 8 such legs in parallel, so `/companies` ends up at serial depth 19 on a
2,005-contact account even though every individual leg is "parallel".

## Design decision: one global gate, not per-call concurrency

The obvious change is a `concurrency` option per call. That is the wrong bound here:
`getContactStages` has 8 legs running simultaneously, so a per-call limit of N produces a
peak of 8N in flight, and the number that actually matters to Supabase is the peak.

Instead: a module-level semaphore in `postgrest.ts` shared by every chunked read, so the
cap is stated once and holds no matter how many legs are in flight. The issue's acceptance
criterion is "peak in-flight bounded and stated explicitly", and a global gate is the only
version of this that can honestly claim it.

Deadlock safety: a task holding a slot never requests a second one. `chunkedPaginated`
holds one slot for its chunk's whole page walk (pages must be sequential to know when to
stop), and `chunked` holds one for a single request. No nesting, so no cycle.

## Order preservation

Callers concatenate chunk results and several downstream consumers assume input order.
Concurrent completion must not reorder output, so results are written into a
pre-sized array by input index rather than pushed on completion. A test drives this with
deliberately staggered per-chunk latency so a naive push-on-complete implementation fails.

## Steps

1. Add `mapWithConcurrency` + the shared gate to `src/lib/data/postgrest.ts`. Read the
   file header first; it is authoritative on why `chunked()` is unsafe for fan-out tables.
2. Rewire `chunked()` and `chunkedPaginated()` through it. Signatures unchanged, so no
   caller edits.
3. Pick the cap from measurement, not taste (see below). Record the numbers in the ticket.
4. Blast radius: these are shared with the MCP server. Check every caller, and confirm the
   MCP scoping gate and the data-query-shape pins stay green.
5. If cheap: mount the four global overlay modals only when opened, so their ~127KB chunk
   stops downloading on every route. Drop this if it complicates the change.

## Choosing the cap

Measure `/companies` against production on the reference account at several caps (4, 8, 12,
16), recording data-ready, serial depth, and any 429 or connection error. Pick the knee,
not the maximum. A cap that is fast on a warm pooler and 429s on a cold one is worse than
the serial version, so a run must be clean on errors to count.

## Verification

`npm run test`, `npm run typecheck`, `npm run lint`, `npm run check:conventions` from
`careervine/`, plus `npm run test:integration` and the `request-budget` e2e spec. Then
re-measure production after deploy with the CAR-229 harness, and lower the `/companies`
ceiling in `e2e/request-budget.spec.ts` rather than leaving slack.
