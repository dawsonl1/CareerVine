# CAR-177: Close the proven guard holes (F35, F10, F36)

Three demonstrated holes from the CAR-28 post-program verification, each proven by injecting a defect into a clean tree and observing every gate stay green. Verification standard for every fix: **inject the defect → watch the gate fail → fix/restore → watch it pass.** The PR records which mutations were run.

## 1. F35 — Gmail OAuth callback security branches have zero coverage

`src/app/api/gmail/callback/route.ts` guards (CSRF userId match at :51, state freshness at :55, state parse at :40, returnTo open-redirect filter at :46) can all be deleted with 2261/2261 tests green.

**Fix:** new `src/__tests__/gmail-callback-security.test.ts`, scaffolded on the existing `gmail-callback-aliases.test.ts` pattern (import the exported `GET`, mock `@/lib/supabase/server-client` auth + `@/lib/oauth-helpers` + googleapis + service client). Behavioral tests, each asserting BOTH the error redirect reason AND that no token exchange/upsert happened:

- `error` param from Google → error redirect, no `getToken`
- missing `code`/`state` → "Missing code or state"
- malformed (non-base64url-JSON) state → "Invalid state", no `getToken`
- **state.userId ≠ session user → "State mismatch", no `getToken`, no upsert** (the F35 mutation target)
- state older than 10 min → "OAuth flow expired"
- valid state → `gmail=connected`, upsert carries `user_id` of the session user
- `returnTo` filtering: `/contacts` honored; `//evil.com` and `https://evil.com` fall back to `/settings`

**Mutations to run:** (a) replace the userId check with `if (false)` — suite must go red; (b) delete the freshness check — suite must go red. Restore both, confirm green.

**Sibling audit:** gmail/auth + gmail/callback are the only routes using the CSRF-state pattern (verified by grep). The other privileged entry shapes (hand-rolled auth mechanisms pinned by `route-auth-inventory`) get a focused check that each rejects a bad credential in some behavioral test; gaps found get tests in this branch, findings recorded in the PR.

## 2. F10 — the MCP scoping gate accepts an unverified `coveredBy` claim

`touches` proves the *driver* hits the table, not that the *covered function* does. A bogus unscoped function classified `{ kind: "mcp-covered", coveredBy: "getContactFull", touches: "contacts" }` passes green.

**Fix: query provenance.** The recording client (`src/mcp/__tests__/helpers/recording-client.ts`) captures `new Error().stack` at `.from()`/`.rpc()` time onto each `RecordedQuery`. Empirically probed: under Vitest, stacks carry named frames with source file paths (`at getContactById (…/src/lib/data/contacts.ts:215)`), including through `paginateAll`/`chunked` indirection. The reachability test in `db-scoping.test.ts` then asserts, for every `mcp-covered` entry, that some recorded query on the `touches` table has a stack frame matching **both** the covered function's name and its module's file path — a declarative-only claim can no longer pass.

**Mutation to run:** add an unscoped export to `src/lib/data/contacts.ts`, classify it exactly as the audit's injection did — the gate must go red on the new provenance assertion (and stay red however classified: unclassified/web-only/mcp-covered are each caught). Remove, confirm 88/88 green.

## 3. F36 — shared-lib query-shape changes pass silently (cheap part only)

Five suites duplicate an inline chain-recording builder for `src/lib/data` functions and assert only that specific filters are *present* — an added filter (`.is("deleted_at", null)`) is absorbed silently. Structural integration-tier fix stays with its own ticket.

**Fix: a query-shape registry test.** New `src/__tests__/data-query-shapes.test.ts`: inject the existing recording client through the real `setDataClient` seam, drive the shared data-layer functions the web+MCP surfaces both consume (`data/follow-ups`, `data/home` reads, `data/contacts` + `data/action-items` entries the existing five suites exercise), and pin each recorded query to an explicit compact signature (`contacts: select eq(user_id) eq(network_status) …` — table + ordered filter methods/columns). Any shape change fails with a diff naming the exact query and filter; updating the pin is a deliberate, reviewable act. The five existing suites stay untouched — their presence-assertions remain valid, and the registry adds the loud exact-shape gate.

**Mutation to run:** add `.is("deleted_at", null)` to a shared contact read (`getContactsWithLastTouch`) — registry must go red naming that query. Revert, confirm green.

## Delivery

Worktree branch `dawson/car-177-59cafc` → PR titled `Close the proven guard holes: callback security coverage, coveredBy provenance, query-shape pins (CAR-177)`. Full `npm run test` before PR. PR body records every mutation run and its observed red/green result.
