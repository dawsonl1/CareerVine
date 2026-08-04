# CAR-151 — Collapse the MCP db.ts fork onto the shared data layer, gated by an exhaustive table-driven scoping test

Wave 4 · T14 of the Straight A's program (CAR-28). Retires findings F7 (db.ts fork duplication) and F10 (scoping test coverage). Unblocked: CAR-146 (queries.ts seam + domain split) merged in PR #112.

## Context (verified against the tree)

`careervine/src/mcp/lib/db.ts` (1,372 lines) hand-reimplements shared business logic under the service-role client. CAR-146 already created the landing zone: `src/lib/data/*` domain modules resolve their client lazily via `db()` in `src/lib/data/client.ts`, with a production-unused `setDataClient()` injection seam, and `company-queries.ts` proves the model (MCP injects the service client via `setCompanyQueriesClient()`; every entry point is userId-parameterized).

Facts that shape the design:

- The MCP HTTP handler is a Next.js route (`src/app/api/mcp/route.ts`) in the same server process as every other route. Injecting the service client into the shared `setDataClient()` slot is only safe because **no server-side code consumes the data layer through the implicit `db()`**: every `@/lib/queries` / `@/lib/data` consumer is a `"use client"` page/component (browser process), except `api/suggestions/save` which passes an explicit client param, and `pipeline-queries.ts` whose consumers are all browser-side. The gate test makes this structural (see closure assertions below).
- The stdio MCP shell is an external sibling project (`careervine-mcp`) compiling `../careervine/src` — `initDb(uid)` + the `stdioUserId` fallback must keep working.
- db.ts's `chunked()` copy is already gone (it imports `chunked`/`escapeIlike`/`paginateAll` from `@/lib/data/postgrest`) — that exit-criterion item is pre-satisfied.
- `getEmailsForContact` in db.ts is dead (zero references) — delete, don't port.
- Exactly one raw `db().from()` exists outside db.ts within src/mcp: `tools/outreach.ts:176` (company-name lookup). The lint rule needs that fixed, not grandfathered.
- Unscoped-under-service-role gaps confirmed in `src/lib/data/`: `buildLastTouchMap` (meetings leg has no `meetings.user_id` filter; interactions leg unscoped), and the by-id-only writes `snoozeContact` / `skipContactFirstOutreach` / `setSuggestionCooldown`, plus most by-id CRUD in contacts/meetings/action-items/interactions. Only the MCP-reachable set must become explicitly scoped; the rest stay RLS-reliant **and provably unreachable from MCP**.

## Design decisions

1. **Injection**: `db.ts` `ensureClient()` calls `setDataClient(serviceClient)` (alongside the existing `setCompanyQueriesClient`). The slot is parked once per process — deterministic, no per-request swapping. Safety rests on (a) every MCP-reachable shared function being explicitly user-scoped, (b) the gate test's import-closure assertion, (c) the eslint guardrail.
2. **Two seam styles, both already established**:
   - `src/lib/data/*` modules: implicit `db()` + explicit `userId` params (browser + injected MCP client).
   - Email helpers: explicit `(client, userId, …)` params (the `follow-up-helpers.cancelFollowUpsForScheduledEmail` pattern), because the web email routes hold their own per-request service client. New shared email logic goes in **`src/lib/data/emails.ts`** using this style; both the web routes and db.ts call it.
3. **Web behavior is canonical.** Where the fork drifted from the shared implementation, the collapse adopts the shared behavior and the deltas are documented in the PR (list below).
4. **db.ts end-state**: `uid()` context + `initDb`/`db`, contact/company resolution + ownership assertions, MCP-shaped projections (fetchSearchRows, listScheduled, dossier), thin uid-binding wrappers over shared functions, and MCP-specific writes that are already scoped one-liners. No reimplemented business logic; `rg 'Port of|port of|reimplemented' src/mcp/lib/db.ts` comes back empty.

## Workstream 1 — Gate first: table-driven scoping suite (F10)

Rebuild `src/mcp/__tests__/db-scoping.test.ts` around a shared recording harness (extracted to `src/mcp/__tests__/helpers/recording-client.ts`, also adopted by `add-contact-location.test.ts` which currently copies the old builder):

- **Recording client**: records every `.from(table)` chain — filters (`eq`, `in`, `is`, `or`, `gte`, `lt`, `lte`, `gt`, `neq`, `not`, `ilike`), mutation payloads (`insert`/`update`/`upsert`/`delete`), `select` columns, `single`/`maybeSingle`/awaited resolution, `{ count }` results, plus `.rpc(name, args)`. Per-test fixture routing: `respond(table, method, ctx) => data` with lenient defaults.
- **Real wiring, not mocks**: the suite mocks only `@/lib/supabase/service-client` (returning the recorder) and analytics; `initDb(USER)` then runs the production injection path, so `setDataClient`/`setCompanyQueriesClient` wiring is itself under test.
- **The table**: one entry per export of db.ts, per export of every `src/lib/data/*` module (incl. the new `emails.ts`), and the three company-queries entry points MCP calls (`getContactStages`, `getCompanies`, `getCompanyDetail`). Entry classifications:
  - `scoped` — invoked through the recorder; **every** recorded operation must carry user scoping: `.eq("user_id", uid)`, an embedded-join filter (`.eq("<embed>.user_id", uid)`), or a mutation payload containing `user_id: uid`.
  - `ownership-asserted` — operations keyed by a parent id are allowed only after a user-scoped query established that id in the same invocation (e.g. `getDossierBundle`, `createContactFull` child writes, `appendNote`'s RPC).
  - `global-table` — justified allowlist for genuinely cross-user tables: `schools`, `companies`, `locations` (+ company-domain reads inside company-queries). Justification string required per entry.
  - `web-only-rls` — not scoped, must NOT be reachable from MCP. Enforced mechanically: the suite parses every import in `src/mcp/**/*.ts` from `@/lib/data/*` / `@/lib/queries` and fails if a `web-only-rls` name is imported.
  - `context` — initDb/db/uid/setDataClient/must/types/pure helpers.
- **Export enumeration**: `Object.keys(await import(module))` — an export without a table entry fails; a table entry without an export fails (stale table).
- **Red-on-mutation property** (exit criterion): deleting one `.eq("user_id")` from a `scoped` function makes its entry fail; adding an unlisted export fails the enumeration. Verified once by hand before the PR.

## Workstream 2 — Scoping fixes inside src/lib/data (the judge's precondition)

- `buildLastTouchMap(userId, contactIds)` (follow-ups.ts): add the userId param; meetings leg becomes `meetings!inner(meeting_date)` + `.eq("meetings.user_id", userId)`; interactions leg gains `contacts!inner()` + `.eq("contacts.user_id", userId)`. Callers threaded: `getHomeCoreData`, `getContactsWithLastTouch`, `getRelationshipsOnTrack` (all already hold userId). Identical results for the web (RLS already filtered); explicit scoping for MCP.
- New `getContactsDueForFollowUp(userId)` in follow-ups.ts: the reach-out derivation currently inlined in `getHomeCoreData` moves to a shared pure helper (`deriveDueFollowUps(contacts, lastTouchMap, now)`); `getHomeCoreData` keeps its single-fetch efficiency by calling the helper; the new export fetches active contacts (scoped, paginated) + last-touch map and returns the same shape. db.ts maps it to the MCP `DueFollowUp` projection.
- `findOrCreateSchool` (contacts.ts): upgrade exact-`eq` name match to escaped-`ilike` (case-insensitive), matching `company-helpers`' find-or-create semantics, so the MCP path keeps its dedup quality and the web gains it. Race-safe 23505 recovery retained.
- `snoozeContact` / `skipContactFirstOutreach` / `setSuggestionCooldown` stay RLS-only (browser writes) → classified `web-only-rls` in the table; MCP cannot import them.

## Workstream 3 — The collapse, domain by domain (diff-then-delete, compiler-backed)

| db.ts today | End state |
| --- | --- |
| `buildLastTouchMap` (own port) | delete; re-export thin wrapper binding `uid()` over shared `buildLastTouchMap` (tools/contacts.ts imports it from db.ts) |
| `listDueFollowUps` (port of getContactsDueForFollowUp) | shared `getContactsDueForFollowUp(uid())` + MCP projection (`has_email`, drop `photo_url`) |
| `getNetworkHealth` on-track/streak/neglected ports | compose shared `getRelationshipsOnTrack(uid())`, `getNetworkingStreak(uid())`, `getNeglectedContacts(uid())`; keep tier counts + last-30-days counts (MCP-specific, scoped) |
| `getContactFull` | shared `getContactById(contactId, uid())` (identical embed) |
| `createContactFull` raw inserts + private `findOrCreateSchool` | orchestrate shared primitives: `findOrCreateLocation`, `createContact` (payload carries `user_id`), `addEmailToContact`, `addPhoneToContact`, `findOrCreateCompany` (company-helpers), `addCompanyToContact`, shared `findOrCreateSchool`, `addSchoolToContact`. Rollback + US-state canonicalization + analytics stay in db.ts |
| `appendNote` | `assertContactOwned` + shared `appendContactNote` |
| `createActionItem` | ownership asserts + shared `createActionItem(payload with user_id, contactIds)` |
| `listActionItems` | shared `getActionItems(uid())` + MCP-side due/direction/contact filtering (projection unchanged) |
| `logInteraction` | `assertContactOwned` + shared `createInteraction` is NOT used (its fire-and-forget `activateContacts` would break the `activated` return contract); keep the scoped insert + `activateContactIfDormant` — documented as MCP-specific |
| `cancelScheduledEmail` | new shared `cancelScheduledEmailCascade(client, userId, emailId)` in `src/lib/data/emails.ts` (CAS pending|failed → cancelled + `cancelFollowUpsForScheduledEmail`), used by web `gmail/schedule/[id]` DELETE and db.ts. MCP adopts web's pending|failed window |
| `cancelFollowUpSequence` | new shared `cancelFollowUpSequenceCascade(client, userId, followUpId)`: user-scoped active→cancelled_user CAS (count-based, rule 17) then unresolved-message cancellation; web `gmail/follow-ups/[id]` DELETE adopts it (fixes its unconditional overwrite of completed sequences) |
| `createScheduledEmail` | shared `insertScheduledEmail(client, userId, input)` used by web schedule POST and db.ts |
| `createAppDraft` | shared `insertEmailDraft(client, userId, input)` used by web drafts POST (create branch) and db.ts |
| `insertFollowUpSequence` | shared `insertFollowUpSequenceRows(client, userId, parent, messageRows)` used by web follow-ups POST and db.ts |
| `getEmailsForContact` | dead — deleted |
| `listCalendarEvents` attendee-matching block | shared `getContactEmailLookup(uid())` (identical map); calendar_events read + link scoping stay (MCP-specific, scoped) |
| `addTargetCompanyNote` | gains an ownership check (target row verified against `uid()` before insert) instead of trusting the caller chain |
| `tools/outreach.ts:176` raw `db().from("companies")` | moves behind a db.ts helper (`getCompanyName`), clearing the lint rule |
| stays (MCP-specific, scoped + table-asserted) | resolution (`resolveContact`/`assertContactOwned`/`resolveCompanyId`), `fetchSearchRows`, `tagContact`, `setNetworkStatus`, `activateContactIfDormant`, `setStageOverride`, `updateActionItem`, `searchEmailHistory`, `getCachedThreadMessages`, `findOriginalOutbound`, `listScheduled`, `getDossierBundle`, `cacheCalendarEvent`, `getOrCreateTargetCompany` |

**Documented behavior deltas (web-canonical adoptions):** MCP cancel_scheduled also cancels `failed` emails; MCP network-health `neglected` counts never-contacted-with-cadence immediately and reads at most 500 active contacts (shared `getContactsWithLastTouch` cap); web follow-up cancel no longer overwrites a completed sequence's status; school find-or-create becomes case-insensitive everywhere.

## Workstream 4 — Lint guardrail + service-role write audit

- `eslint.config.mjs`: two additions —
  1. `no-restricted-imports` on `@/lib/supabase/service-client` for all of `src/**`, with the current importer list grandfathered via a checked-in allowlist block (each entry carries a one-line justification comment). A new file importing it fails lint.
  2. Within `src/mcp/**` (except `lib/db.ts`): forbid acquiring/using the raw client — `no-restricted-imports` on the `db` importName from `@/mcp/lib/db` + `no-restricted-syntax` on `db().from(...)` call shapes.
- `api/transcripts/transcribe/route.ts` (~:115): add `.eq("user_id", user.id)` to the meetings update; scope the sibling `attachments` lookup the same way if the audit confirms it reads by `object_path` alone.
- Grep-audit every service-client importer's writes for upstream-check-only scoping (meeting_contacts exempt — no user_id column); fix or annotate each finding.

## Workstream 5 — Verification

1. Full suite (`npm run test`) + `npm run build` from `careervine/` — all 206 files/1,811 tests currently green as the baseline; existing MCP tests (dossier, add-contact-location, tool-schemas, user-context) must stay green through the collapse.
2. Mutation spot-checks (by hand, once): remove one `.eq("user_id")` → red; add an unlisted export → red.
3. Parity fixture tests: one fixture network driven through both the shared functions and the db.ts wrappers via the recording client, asserting the MCP projections (contacts due, on-track, streak) are derived from identical query shapes — the in-repo equivalent of the web-vs-MCP seed-data spot-check (no service-role poking at production).
4. `npx eslint` on a scratch file importing the service client → error; on `src/mcp/**` → clean.
5. Exit-criteria checklist run: `rg 'Port of|port of|reimplemented' src/mcp/lib/db.ts` empty; export/table enumeration green; lint guardrail proven.

## Sequencing

Gate harness + table over the CURRENT surface first (locks today's scoping), then per domain: scope shared fn → collapse db.ts → extend/flip table entries → suite green. Lint + audit last (after the outreach.ts fix). One PR; commits land per domain so the diff reviews as the ticket's "one domain at a time".

## Risks / notes

- db.ts stays several hundred lines even after all duplication dies (resolution, projections, dossier, email reads are genuinely MCP-specific); the binding exit criteria are the rg-empty check, the exhaustive table, and the lint rule.
- The `QueryClient` type (browser-client return) vs service client: same `SupabaseClient<Database>` shape; the one existing cast in db.ts (`setCompanyQueriesClient`) is the precedent if TS complains.
- Analytics (`trackServer`/`checkContactMilestone`) keep their own internal service client — untouched, mocked in tests, allowlisted in lint.
- Stdio path (`initDb(uid)` + `stdioUserId`) preserved; `runWithUser` ALS unchanged.
