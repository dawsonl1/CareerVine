# CAR-229 — Web app load performance

Measured baseline, root causes and acceptance criteria live in the Linear issue. This
file is the execution plan: what changes, in what order, and how each step is proved.

## Correction carried over from the audit

The audit's claim that CAR-96's "triple-load on mount" had regressed was **wrong**, and the
Linear issue has been corrected. The three parallel `contacts?offset=0&limit=50` requests are
the three network tiers streaming as CAR-94 designed. No duplicate-mount bug exists on
`/contacts`. The real problem there is that all three tiers load to exhaustion because tier
toggles and search are client-side filters over an in-memory superset.

One genuine correctness bug found while reading: `fetchUserEmploymentRows`
(`careervine/src/lib/company-queries.ts:549`) range-paginates **without an `.order()`**, which
the repo's own `paginateAll` header calls out as unsafe (rows can duplicate or drop at page
boundaries). Stage 1 removes the function; if it survives in any form it gets an order.

## Execution order

Waves are ordered so that independent, low-risk work lands and is verified before the
architectural changes, and so no two concurrent edits touch the same file.

### Wave 1 — contained fixes (disjoint file sets, done in parallel)

**1A. Bundle** — `src/app/layout.tsx`, `src/app/settings/page.tsx`, `src/lib/analytics/client.tsx`
- `next/dynamic` the four globally-mounted modals so ProseMirror/TipTap/DOMPurify stop
  shipping to every route. They are all user-triggered overlays; none renders on first paint.
- `next/dynamic` the seven settings sections; only one is on screen at a time.
- Gate PostHog session recording so the rrweb recorder is not on the critical path.

**1B. Shell tax + the two bugs** — `src/lib/api-handler.ts`, `src/proxy.ts`,
`src/components/compose-email-context.tsx`, `src/app/api/gmail/connection/route.ts`
- Move the `web_last_seen_at` stamp off the awaited path (`api-handler.ts:521`).
- Narrow the `proxy.ts` matcher so the per-navigation `getUser()` skips public paths.
- Collapse the three `gmail_connections` reads to one shared source.
- Break the depth-2 unread-badge chain, and stop the double fetch caused by
  `isFreeOutreach` flipping after `/api/capabilities` resolves.
- Stop `/api/calendar/sync` 429s reaching the critical path.

**1C. Redundant full-list fetches + `/meetings` N+1** — `src/app/contacts/[id]/page.tsx`,
`src/app/calendar/page.tsx`, `src/app/meetings/page.tsx`, `src/lib/data/meetings.ts`
- Drop `getContacts(user.id)` from the three pages that only need name lookups.
- Batch the per-meeting action-items/attachments/transcript reads into `in.(...)` queries.

### Wave 2 — the architectural core (sequential, one author)

**2A. Server-side company aggregate** — new migration + `src/lib/company-queries.ts`
- Replace `fetchUserEmploymentRows`' ~18k-row sweep with a Postgres RPC returning one row
  per company (counts, current/former split, stage rollup). Applied to production before
  merge per rule 42, since the client reads what the migration adds.

**2B. `/contacts` stops loading every tier** — `src/app/contacts/page.tsx`, `src/lib/data/contacts.ts`
- Load the active tier on mount; fetch prospect/bench when their toggle is enabled.
- Move search server-side so it still spans the whole network (CAR-222's requirement)
  rather than only the loaded superset.

**2C. Read cache + dedup at the data seam** — `src/lib/data/cache.ts` (new) + call sites
- Dedup in-flight identical reads and serve a short-TTL cache, so the dashboard's 11
  `contacts` reads collapse and re-navigation stops refetching.
- Invalidation is centralised in the same `src/lib/data/*` modules that own the mutations.
  A stale list after an edit is a worse regression than the slowness being fixed, so
  every mutation path gets an explicit invalidation and a test that proves it.

**2D. `/api/suggestions/generate` off the load path** — `src/hooks/use-suggestions.ts` + route
- Serve the last result immediately, regenerate in the background.

### Wave 3 — regression guard

The audit found four Done tickets in this area, which is the argument for a mechanical
check rather than another round of manual measurement.

- A Playwright spec that loads each route against a seeded account and asserts a
  **request-count ceiling** per route, so a reintroduced N+1 or whole-table sweep fails CI.
- A unit-level guard asserting no `src/lib/data` read paginates an unbounded table without
  both an `.order()` and a caller-supplied bound.

## Verification

Per stage: `npm run test`, `npm run typecheck`, `npm run check:conventions` from `careervine/`.
Before PR: full `npm run test`, `npm run build`, `npm run test:integration`, and a re-run of
the audit harness against the deployed branch to confirm the acceptance numbers.
