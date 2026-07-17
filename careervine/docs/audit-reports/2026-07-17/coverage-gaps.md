# Test-Coverage Gap Map (Task 1)

**Date:** 2026-07-17
**Scope:** `careervine/src/**` (the Next.js product, MCP server, shared libs)
**Method:** `npx vitest run --coverage` (v8) + a full source-tree vs. test-file
cross-reference, because the project's vitest config has no `all: true`, so the
text coverage table lists **only files imported by a test**. Files absent from
the coverage instrumentation are reported as `none` (never imported by any
test = zero coverage). Per-file percentages below are v8 **statement** coverage
pulled from `coverage/coverage-final.json`.

> This is a read-only audit. No tests were written. "First test should assert"
> notes describe the highest-value behavior to lock down; they are not edits.

---

## Summary

| Metric | Value |
| --- | --- |
| Test files | 195 (1708 tests, all passing) |
| Overall statements | **59.52%** (6478 / 10882) |
| Overall lines | **62.47%** (5858 / 9376) |
| Overall branches | **53.19%** (4748 / 8926) |
| Overall functions | **53.20%** (987 / 1855) |
| Source modules (non-test, excl. generated/type-only) | **400** |
| Modules with **zero** coverage (never imported by any test) | **201** (~50%) |

**Headline:** the pure-logic core is well covered (bundle math, scrape
mappers, diff engine, crypto, capabilities, most cron *libraries* all 85-100%),
but three whole surfaces are near-dark: **Apify paid-scrape billing**, the
**Google Calendar integration**, and **MCP tool handlers**. The single largest
untested blast radius is the primary data layer (`queries.ts` at 6%,
`company-queries.ts` at 10%, `pipeline-queries.ts` at 9%). Route **wiring**
(QStash signature checks, cron guards, auth gates) is broadly untested even
where the underlying library it calls is at 100%.

The good news, up front: **crypto/BYOK is in good shape** (`crypto.ts` 93.9%,
key-store routes 84-88%), so category 5 is the shallowest gap.

---

## Ranked gap map (highest risk first)

Ordering follows the mandated risk priority: (1) money/billing/bundle,
(2) auth/session/token, (3) sync engines, (4) MCP tools, (5) crypto/BYOK,
(6) everything else. Within a category, lower coverage and larger blast radius
rank higher.

### 1. Money / billing / bundle paths

| # | Module | Cov | Why risky | First test should assert |
| --- | --- | --- | --- | --- |
| 1 | `src/lib/apify/scrape-service.ts` | **none** | Orchestrates every **paid** LinkedIn scrape: monthly-cap gate, atomic one-in-flight-per-contact guard, cost stamping, webhook ingest. Zero of this is exercised — the actual money gate and idempotency are untested. | `trigger()` refuses to start when month-to-date spend ≥ `MONTHLY_SCRAPE_CAP_USD` (no run created); `ingest()` correlates by `scrape_runs` id and stamps cost exactly once (re-ingest is a no-op). |
| 2 | `src/lib/apify/spend.ts` | **16.0%** | Spend accounting + cap math; comment says all readers must **fail closed**. An under-count authorizes paid runs over budget; a swallowed query error reads as $0. | `estimateRunCostUsd` prices `Discovery` as `DISCOVERY_PAGE_COST_USD` (not the ~10x-too-low contact-count formula) and `unit x count` otherwise; a ledger query error **throws** rather than returning 0. |
| 3 | `src/lib/apify/client.ts` | **6.5%** | Minimal REST client that actually starts paid runs; correctness of `maxTotalChargeUsd` and the exact `MODE_INPUT` actor-input string is the last line before real spend. | `startProfileScrapeRun` request body carries a non-null `maxTotalChargeUsd` cap and the correct `MODE_INPUT` string per mode; non-2xx throws `ApiError`. |
| 4 | `src/lib/apify/resolver.ts` | **none** | Paid name-resolution searches ($0.004 each), also cap-gated; URL-rot repair triggers follow-on enrich scrapes. Unbounded resolve spend if the gate breaks. | `resolveContactLinkedin` ledgers under `mode='resolve'` and honors `MONTHLY_SCRAPE_CAP_USD`; `linkContactLinkedin` writes the canonical URL and enqueues an enrich scrape. |
| 5 | `src/lib/bundle-apply-client.ts` | **2.6%** | Client-side subscribe/apply driver with the CAR-47/CAR-78 cursor+retry loop that applies purchased bundle contacts. A loop bug double-applies or silently strands a user's sync. | Given a scripted sequence of `ApplyStep` responses ending `done:true`, the loop terminates and returns `completed:true` with the final `path`; a 5xx surfaces `BACKGROUND_SYNC_MESSAGE` and does not throw. |
| 6 | `src/app/api/admin/bundles/publish/route.ts` | **28.8%** | Publishing computes the payload + fingerprint every subscriber then applies; branch coverage on failure paths is thin (lines 86-180 uncovered). | Non-admin caller is rejected (403); a successful publish advances `version`/`fingerprint` and marks the bundle `published`. |
| 7 | `src/app/api/admin/users/[id]/bundle-access/route.ts` | **none** | Grants/revokes per-user bundle **entitlement** overrides via the RLS-bypassing service client. An over-permissive override exposes a hidden/paid bundle. | `PATCH` requires admin, writes an audit row, and the override flips `effectiveBundleVisibility` for that user only. |
| 8 | `src/lib/apify/discovery.ts` | **40.8%** | Discovery runs (per-page priced) feed the paid pipeline; large uncovered spans (169-256, 363-532) include page accounting. | A discovery run records spend per search page (not per candidate) and dedups candidates already in the network. |
| 9 | `src/app/api/bundles/unsubscribe/route.ts` | **none** | Subscription-state mutation; wrong scope could unsubscribe another user or leave dangling applied contacts. | Unsubscribing flips only the caller's subscription row (RLS scope) and is idempotent. |

_Well-covered here (no action):_ `bundle-sync` 91%, `bundle-publish` 88%,
`bundle-payload` 92%, `bundle-fast-apply` 93%, `bundle-resolve` 86%,
`bundle-queue` 92%, `bundle-fingerprint` 100%, `outreach-queue` 100%,
`ai/spend` 96%, `bundles/apply` route 90%.

### 2. Auth / session / token

| # | Module | Cov | Why risky | First test should assert |
| --- | --- | --- | --- | --- |
| 10 | `src/lib/extension-auth.ts` | **8.3%** | `getExtensionAuth` is the single gatekeeper for **every** Chrome-extension API route (dual Bearer-token + cookie auth). A bug here authenticates the wrong user or bypasses auth across all extension endpoints. | Missing/invalid Bearer returns a 401 error response; a valid Bearer resolves the exact authenticated `user`; cookie fallback authenticates the webapp path. |
| 11 | `src/lib/supabase/service-client.ts` | **20%** | The service client **bypasses RLS**. Anywhere it is used where a user-scoped client belongs is a cross-tenant read/write. | The factory is constructed with the service-role key (not anon) and targets the configured project URL. |
| 12 | `src/lib/supabase/config.ts` | **9.1%** | `getSupabaseEnv` resolves the env every client is built from; a silent misconfig points clients at the wrong project. | Throws a clear error when a required env var is absent; returns `{url, key}` when present. |
| 13 | `src/lib/supabase/server-client.ts` | **12.5%** | Server client wires request cookies → session; a broken cookie adapter drops or leaks the session. | Builds a client that reads/writes the request cookie store for the session. |
| 14 | `src/lib/oauth-helpers.ts` | **61.3%** | Gmail + Calendar OAuth token encrypt/decrypt/refresh. Uncovered branches (63-77, 104-111) are exactly the **expiry/refresh** decision path. | `refreshTokenIfNeeded` refreshes when expiry is within skew and persists the rotated token; `decryptOAuthToken` round-trips an encrypted token and rejects a tampered one. |
| 15 | `src/app/api/gmail/callback/route.ts` | **none** | OAuth callback: exchanges the code and **stores encrypted tokens** — the token-persistence entry point. | A state/CSRF mismatch is rejected; a valid code persists tokens encrypted (never plaintext) to `gmail_connections`. |
| 16 | Admin privileged-mutation routes: `admin/users/[id]/{role,status,ai-policy}/route.ts`, `admin/users/route.ts`, `admin/users/[id]/route.ts` | **none** | Privilege/role/status mutations; a missing `requireAdmin` is direct privilege escalation. (`route-auth-inventory.test.ts` + `architecture-boundaries.test.ts` give a **static** guard that each route declares auth, but no behavioral test drives the mutation.) | Non-admin caller is rejected (403); a role/status change writes an audit row and cannot elevate the acting user. |

_Well-covered here:_ `admin-auth.ts` 100%, `mcp/verify-token.ts` 89%,
`mcp/auth-config.ts` 83%, `notify/tokens.ts` 100%, `auth/confirm` route
(tested), `machine-token-auth` (tested).

### 3. Sync engines (gmail / calendar / email-send / scheduled / nudges)

| # | Module | Cov | Why risky | First test should assert |
| --- | --- | --- | --- | --- |
| 17 | `src/lib/gmail.ts` | **38.1%** | The core Gmail sync + `processScheduledEmails` engine; huge uncovered regions (616-742, 928-1015) cover threading/dedup/paging. | A sync pass dedups already-seen messages and returns a cursor when the time budget is exhausted, resuming from it on the next pass. |
| 18 | `src/lib/calendar.ts` | **none** | The **entire** Google Calendar service: token reuse, event fetch/sync, free/busy, and `mergeBusyIntervals` availability math. Availability feeds meeting scheduling — wrong busy math books over real events. | `mergeBusyIntervals` collapses overlapping/adjacent intervals into the minimal set and leaves disjoint ones intact. |
| 19 | `src/lib/gmail-sync-client.ts` | **5.9%** | Client full-sync loop with the `MAX_PASSES` runaway guard and cursor paging; a short/infinite loop drops contacts or hangs the UI. | `runFullGmailSync` loops until a pass returns no cursor, summing totals; it stops at `MAX_PASSES` and throws on a non-ok response. |
| 20 | `src/app/api/cron/send-scheduled-emails/route.ts` | **none** | QStash-signed scheduled-send cron. The signature-verify branch + `withCronGuard` wiring are untested; a broken verify either drops **all** scheduled sends or accepts forged calls. (`processDueScheduledEmails` in `scheduled-email-cron.ts` is 100% — only the wiring is dark.) | A bad `upstash-signature` returns 401; a valid signature invokes `processDueScheduledEmails` inside `withCronGuard`. |
| 21 | `src/app/api/gmail/sync/route.ts` | **16.7%** | The sync route handler that the client loop drives; returns/consumes the cursor. | Returns a cursor + partial totals when contacts remain; returns final totals with no cursor when done. |
| 22 | Cron route **wiring**: `cron/{scrape-refresh,discovery,storage-sweep,data-retention}/route.ts` | **none** | Each cron's library is well covered (`data-retention` 90%, `storage-sweep` 95%) but the route wiring (QStash signature + `withCronGuard`) is not — a wiring regression fails silently. | Bad signature → 401; valid signature runs the underlying job exactly once under the cron guard. |
| 23 | Gmail mutation sub-routes: `emails/[messageId]/{hide,move,read,trash}`, `drafts`, `schedule/[id]/retry`, `templates`, `follow-ups/{process,awaiting-review}` | **none** | Direct mailbox side-effects (trash/move/schedule) with no behavioral coverage; wrong-user scoping or a bad Gmail call is destructive. | Each mutates only the caller's mailbox and returns the modified state; unauthorized/other-user access is refused. |

_Well-covered here:_ `email-send.ts` 96%, `scheduled-email-cron.ts` 100%,
`gmail-send-core.ts` 77%, `change-events/*` 91-98%, cron `follow-up-nudges`
route 91%, `calendar/sync` route 79%.

### 4. MCP server tools

| # | Module | Cov | Why risky | First test should assert |
| --- | --- | --- | --- | --- |
| 24 | `src/mcp/tools/email.ts` | **6.1%** | MCP tool that **sends/drafts real email** on the user's behalf; only the schema shape is tested (`tool-schemas.test.ts`), none of the send behavior or recipient policy. | The send tool routes through `email-policy` recipient resolution and refuses when no verified recipient resolves; it never sends to an unverified address. |
| 25 | `src/mcp/lib/db.ts` | **12.1%** | The MCP data layer (1365 lines, ~88% dark) — every tool's DB access and per-user scoping. `db-scoping.test.ts` exists but only touches a sliver. | Each accessor is scoped to `uid()` and cannot read/write another user's rows. |
| 26 | `src/mcp/tools/calendar.ts` | **none** | Creates **real calendar events** via `createCalendarEvent`; `parseInstant` enforces an explicit timezone offset (a silent-local-time bug books the wrong hour). | `parseInstant` throws on an ISO without a `Z`/offset; the create tool passes the parsed instant through to `createCalendarEvent`. |
| 27 | `src/mcp/tools/outreach.ts` | **none** | Company/stage mutations and outreach-queue building from the shared data layer. | `buildOutreachQueue` tool returns compacted companies ranked by priority; `setStageOverride` is scoped to the acting user. |
| 28 | `src/mcp/tools/upkeep.ts` | **none** | `log_interaction`, action-items, follow-ups — mutations that **graduate contacts** into the active network and reset follow-up clocks. | `log_interaction` maps `todo→my_task` / `waiting_on→waiting_on` and activates a dormant contact. |
| 29 | `src/mcp/tools/contacts.ts` | **11.5%** | Contact CRUD via MCP (86-218 uncovered). | `add_contact` resolves-or-creates and writes only under the acting user; duplicate resolution matches on canonical LinkedIn URL. |
| 30 | `src/mcp/register-tools.ts` | **none** | Analytics wrapper monkey-patches `registerTool` around **every** tool; a bug in the wrapper (it awaits `trackServer`) could break or slow all tool calls. | `instrumentToolCalls` emits exactly one `mcp_tool_called` (name + success flag + duration) per call and never fails the underlying tool when tracking errors. |
| 31 | `src/mcp/lib/tool-utils.ts` | **22.2%** | The shared `handler()` error-shaping wrapper + `contactRefShape` used by every tool. | `handler` catches a thrown `Error` and returns an `isError` content payload rather than propagating the throw. |
| 32 | `src/app/api/mcp/route.ts` | **none** | The remote MCP HTTP transport entry point. Token auth is covered elsewhere (`machine-token-auth`, `verify-token` 89%) but the route wiring itself is dark. | A request without a valid machine/bearer token is rejected; a valid one dispatches to the registered tool set. |

_Well-covered here:_ `mcp/verify-token` 89%, `mcp/user-context` 87%,
`mcp/auth-config` 83%, `mcp/lib/email-policy` 96%, `mcp/lib/dossier` 100%,
`mcp/lib/markdown` (tested).

### 5. Crypto / encryption (BYOK) — shallowest gap

| # | Module | Cov | Why risky | First test should assert |
| --- | --- | --- | --- | --- |
| 33 | `src/lib/crypto.ts` | **93.9%** | Near-complete; uncovered lines 55/60 are the failure branches (bad key / auth-tag mismatch). Only remaining risk is a silent decrypt-of-tampered-data path. | `decrypt` **throws** on tampered ciphertext or a wrong key (GCM auth-tag failure), never returning garbage plaintext. |
| 34 | `src/app/api/settings/{openai-key,deepgram-key}/route.ts` | **88.1% / 84.6%** | BYOK store/rotate; mostly covered, uncovered spans are error/validation branches. | Rejects a malformed key with 4xx and never persists the plaintext key (only ciphertext lands in the row). |

Category 5 is effectively done — flag only the two assertions above.

### 6. Everything else (ranked by blast radius)

| # | Module | Cov | Why risky | First test should assert |
| --- | --- | --- | --- | --- |
| 35 | `src/lib/queries.ts` | **6.0%** | The app's **primary** contact/interaction data layer — 2493 lines, ~94% dark. RLS-scoped reads/writes and network-tier derivation flow through here; the single largest untested surface in the repo. | The core contact-list query applies the active-network filter and user scope, and network-tier counts match a known fixture. |
| 36 | `src/lib/company-queries.ts` | **9.9%** | Company aggregation (current/former/bench counts, traction, target derivation); also consumed directly by MCP outreach tools. | `getCompanies` computes current/former/bench counts and target derivation for a fixture. |
| 37 | `src/lib/pipeline-queries.ts` | **8.6%** | Pipeline stage data powering the companies pipeline board. | The pipeline query returns rows grouped by stage, scoped to the user. |
| 38 | `src/lib/company-scopes.ts` | **13.2%** | Scope/facet filtering (50-67, 120-247 dark) that narrows company lists; wrong scope shows/hides the wrong companies. | A scope filter narrows to the expected company set and its facet counts. |
| 39 | `src/lib/ai-followup/{gather-context,generate-suggestions,generate-draft}.ts` | **46.7 / 42.3 / 57.6%** | AI draft/suggestion generation — spends AI budget and produces user-facing outbound copy from partially-covered prompt assembly. | `gatherContext` assembles the expected context slots; `generateDraft` returns a structured draft and never emits an em dash (rule 35) in user-facing copy. |
| 40 | UI components & pages (bulk) — e.g. `landing-page.tsx`, `navigation.tsx`, all `src/app/**/page.tsx`, most modals (`follow-up-modal`, `quick-capture-modal`, `contact-edit-modal`, `conversation-modal/*`, `email/inbox/inbox-shell`), all `components/admin/*`, most `components/home/*` and `components/settings/*` | **none** (≈150 files) | Individually lower per-file risk, but this is the bulk of the 201 zero-coverage modules. Highest-value first tests are on stateful modals with data mutations, not presentational cards. | For the highest-traffic mutating modal (e.g. `contact-edit-modal`), a save submits the edited fields and closes on success; validation blocks an empty required field. |

_Notably already covered in "everything else":_ `api-handler` 95%, `rate-limit`
(tested), `api-schemas` (tested), `scrape-mapper` 97%, `scrape-merge` 98%,
`diff-engine` 98%, `capabilities/*` 100%, `location-normalizer` 92%,
`transcript-parser` 96%, `data-retention` 90%, `storage-sweep` 95%.

---

## Appendix A — Zero-coverage modules by area (count)

201 modules are never imported by any test. Distribution:

| Area | Zero-coverage files | Notes |
| --- | --- | --- |
| `src/app/api/**` route handlers | ~75 | Route **wiring** largely untested even where the called library is 100%. Gmail sub-routes, calendar routes, contact routes, discovery, transcripts dominate. |
| `src/app/**/page.tsx` + layouts | ~25 | Server/client page shells; low unit-test value, higher e2e value. |
| `src/components/**` | ~90 | Admin panels, home widgets, contact tabs, pipeline panels, settings sections, most `ui/*` inputs. |
| `src/lib/**` | ~14 | Highest-value: `calendar.ts`, `apify/{scrape-service,resolver}.ts`, `cron-guard.ts`, `notify/email.ts`, `extension-auth`-adjacent, `ai-helpers.ts`, `priority-helpers.ts`, `nav-history.ts`, `admin-notify.ts`. |
| `src/mcp/**` | 5 | `tools/{calendar,outreach,upkeep}.ts`, `register-tools.ts`, `prm-handler.ts`. |
| `src/hooks/**` | 4 | `use-suggestions`, `use-pipeline-autosave`, `use-contacts-with-emails`, `use-deferred-action`. |

## Appendix B — Method & caveats

- Coverage run: **passed** (195 files, 1708 tests, exit 0, 12.3s). Per-file
  numbers come from `careervine/coverage/coverage-final.json` (v8 statement
  coverage); overall totals from the run's summary.
- `all: true` is **not** set in `vitest.config.ts`, so the text table omits any
  file no test imports. The 201 zero-coverage figure comes from enumerating
  `src/**/*.{ts,tsx}` (excluding `*.test.*`, `__tests__/`, and generated/
  type-only files: `database.types.ts`, `app-types.ts`, `*/types.ts`) and
  subtracting the 200 instrumented files.
- "Zero coverage" here means **not imported by any test** — a strong proxy for
  untested. A handful of these files are indirectly exercised only through
  mocked boundaries (e.g. `scheduled-email-process.test.ts` imports
  `processScheduledEmails` from `gmail.ts`, not the cron route), which is why
  the route wiring shows as dark while its library does not.
- Static guards partly offset the auth-route gaps: `route-auth-inventory.test.ts`
  and `architecture-boundaries.test.ts` assert each route **declares** an auth
  requirement, but do not drive the handler behavior.
