# CAR-146 — Injection seam, dead-export purge, and domain split of queries.ts with the must() read convention

**Ticket:** [CAR-146](https://linear.app/career-vine/issue/CAR-146) · Wave 3 · T9 of the Straight A's program (CAR-28). Retires F53, F29; closes the F6 class inside the new data layer. Blockers CAR-138 (CI) and CAR-142 (typed clients) are both Done/merged — branch sits on `origin/main` (2d754f8).

## Inventory (verified against the working tree)

`careervine/src/lib/queries.ts` is 2,500 lines with **94 exported functions** and a module-scope browser client (line 23). Import analysis (parsing actual `import {...} from "@/lib/queries"` statements, not word-greps):

- **81 exports are imported somewhere** (app pages, components, hooks, one server route, tests).
- **11 exports are fully dead** (never imported anywhere): `updateContactEmail`, `deleteContactEmail`, `updateContactPhone`, `deleteContactPhone`, `deleteTag`, `getContactsDueForFollowUp`, `getEmailsForContact` (an unrelated same-named fn lives in `mcp/lib/db.ts`), `getFollowUpsForThread`, `getActiveFollowUps`, `updateSegmentContact`, `getRecentUncontactedContacts` (superseded by `getHomeCoreData`). The ticket estimated 10; verified count is 11 — all deleted.
- **2 exports become internal**: `activateContacts` (callers only inside queries.ts: replaceContactsForMeeting, addContactsToMeeting, createInteraction) and `getContactsWithLastTouch` (callers: getNetworkHealthSummary, getNeglectedContacts, plus one test). They stay exported from their domain modules (cross-module/test use) but are **not re-exported by the barrel**.
- `src/app/api/suggestions/save/route.ts` (server) imports `createActionItem` and passes its own route-handler client via the third param — the seam must preserve that path.
- Test mocking styles are all compatible with a lazy client: chain-recorder mocks of `@/lib/supabase/browser-client` (health, home-recent, tier-counts, streamed) and `vi.mock("@/lib/queries", factory)` (compose/onboarding/integrations tests). One test imports `getContactsWithLastTouch` from the barrel and must be re-pointed to the domain module.

## Architecture

New directory `careervine/src/lib/data/`:

| File | Contents |
| --- | --- |
| `client.ts` | Lazy `db()` resolver + `setDataClient()` injection (pattern copied from `company-queries.ts:24-39`, which MCP already injects into via `setCompanyQueriesClient`) + `must()` + `QueryClient` type |
| `postgrest.ts` | Shared PostgREST scale utilities: `escapeIlike`, `chunkList`, `chunked`, `paginateAll` + two-line convention header (`.in()` lists must chunk; unbounded multi-row reads must paginate — PostgREST caps at 1000 rows) |
| `contacts.ts` | Contact CRUD, list selects (CONTACTS_SELECT/CONTACTS_LIST_SELECT), photo, emails/phones/tags subresources, tag entity CRUD, companies/schools/locations linking, activation (`activateContacts` internal, `activateContact`, `getNetworkTierCounts`), `getContactEmailLookup`, `getEmailProvenance`, `markEmailVerified`, `getFreshJobChangeContactIds` |
| `interactions.ts` | getInteractions, getAllInteractions, createInteraction, updateInteraction, deleteInteraction |
| `meetings.ts` | Meetings CRUD, meeting_contacts links, transcript segments |
| `action-items.ts` | follow_up_action_items CRUD + junction, snoozeActionItem, getOnboardingActionItemId |
| `follow-ups.ts` | Reach-out cadence & relationship health: buildLastTouchMap (internal), getContactsWithLastTouch (internal), getRelationshipsOnTrack, getNetworkHealthSummary, getNeglectedContacts, snoozeContact, skipContactFirstOutreach, setSuggestionCooldown, getRecentCutoff (internal, shared with home) |
| `home.ts` | Home dashboard aggregates: getHomeCoreData, getActionListCounts, getNetworkingStreak, getHomeStats, getActivityHeatmap |
| `attachments.ts` | uploadAttachment, add/get attachments for contact/meeting, getAttachmentUrl, deleteAttachment |
| `users.ts` | getUserProfile, updateUserProfile, getDismissedGettingStarted, setDismissedGettingStarted, getGmailConnection |

The ticket names 6 domain files; the deliberate domain-assignment pass adds `attachments.ts` and `users.ts` rather than shoehorning profile/gmail/attachment functions into "contacts" (the ticket anticipates judgment here — only 6 section comments exist for a 1,100-line undifferentiated block).

`queries.ts` becomes a **pure re-export barrel** with a freeze-rule header. **Explicit named re-exports, not `export *`** — that is what keeps `activateContacts`/`getContactsWithLastTouch` un-exported at the barrel while still importable across `src/lib/data/*` and by tests. All 30+ importer files compile unchanged.

## Seam

`client.ts`:

```ts
type QueryClient = ReturnType<typeof createSupabaseBrowserClient>;
let injectedClient: QueryClient | null = null;
let browserClient: QueryClient | null = null;
export function setDataClient(client: QueryClient | null) { injectedClient = client; }
export function db(): QueryClient {
  if (injectedClient) return injectedClient;
  if (!browserClient) browserClient = createSupabaseBrowserClient();
  return browserClient;
}
```

- Every `supabase.` in the 83 surviving functions becomes `db().`.
- `createActionItem(actionItem, contactIds?, client?)` keeps its param; body uses `client ?? db()` (renamed local — `db` name now taken by the import).
- `pipeline-queries.ts` deletes its private fourth lazy-client variant (lines 25-30) and imports `db` (and `QueryClient`) from `@/lib/data/client` — riding the same seam gives it injection for free.
- `company-queries.ts` keeps its own injected seam (MCP wires `setCompanyQueriesClient` today; collapsing that fork is CAR-151's scope). This ticket only takes its duplicated `chunked()`.
- `setDataClient(null)` reset supported for tests. No production caller yet — MCP adoption lands in CAR-151.

## must() convention (F6 class closure inside src/lib/data)

`client.ts` exports:

```ts
export function must<T>(res: { data: T; error: null } | { data: null; error: PostgrestError }): T {
  if (res.error) throw res.error;
  return res.data;
}
```

Typing note: for `.maybeSingle()` T unifies to `Row | null` (missing row stays expressible); for bare mutations T = null. Structurally matches supabase-js v2 success/failure unions.

Audit of every currently-unchecked read moving into `src/lib/data`, with disposition:

| Site | Class | Disposition |
| --- | --- | --- |
| buildLastTouchMap (2 queries) | drives follow-up nags / health / on-track — data correctness | `must()` (its three callers already throw on their sibling primary queries; home page wraps in try/catch & allSettled) |
| deleteContact survivor probe | claim precondition — errored probe today wrongly writes a suppression tombstone that freezes a surviving duplicate out of re-imports | `must()` |
| findOrCreateSchool existing-probe | dedup check — errored probe today falls through to INSERT (dup rows) | `must()` |
| findOrCreateLocation existing-probe | dedup check — same | `must()` |
| getOnboardingActionItemId | gates action-item update/delete; both callers (extension-onboarding-modal) already wrap in try/catch with deliberate "harmless" comments | `must()` |
| deleteAttachment junction deletes (3, results ignored entirely) | delete-path correctness — silent partial failure orphans junction rows | `must()` |
| getEmailProvenance | cosmetic compose badge | keep tolerance + `// error-tolerated:` |
| getHomeStats count destructures | cosmetic stat tiles (zeros on error today) | keep + annotation |
| getActionListCounts | cosmetic height prediction | keep + annotation |
| getNetworkingStreak | cosmetic streak widget | keep + annotation |
| getActivityHeatmap (5 reads) | cosmetic visualization | keep + annotation |
| getNetworkTierCounts | already explicitly handled (returns zeros) | unchanged |
| activateContacts | deliberate fire-and-forget with console.error + comment | unchanged |

## Utility dedupe (F53) + scale utility (F29)

`postgrest.ts` becomes the single home:

- **`escapeIlike`** (canonical name; behavior identical to `escapeIlikePattern`). `search-helpers.ts` (whose only export is the duplicate) is **deleted**. Re-point: `company-helpers.ts` (drops its export, imports instead), `company-queries.ts`, `app/api/contacts/search/route.ts`, `mcp/lib/db.ts`, `bulk-import.ts`, `search-helpers.test.ts` (renamed/moved into the new postgrest test). Exit: exactly one exported ilike escaper under src/lib.
- **`chunkList`** moves verbatim from `company-helpers.ts:99`; re-point importers: bulk-import, bundle-sync, import-db-helpers, bundle-resolve, bundle-fast-apply, company-helpers internals.
- **`chunked`** (async .in() runner, 200/chunk) — one copy replaces three verbatim locals: `company-queries.ts:44`, `mcp/lib/db.ts:61`, `contact-employment.ts:42` (`chunkedQuery`).
- **`paginateAll(fetchPage, pageSize=1000)`** — range-pagination helper; treats a null page as empty (chain-recorder test mocks resolve `data: null`; real PostgREST never nulls a select success).

Applied to the verified-live gaps as the domains are extracted:

- `buildLastTouchMap` — both `.in()`s chunked (+ must).
- `getFreshJobChangeContactIds` — `.in()` chunked (exit criterion: every `.in()` over caller-supplied ids goes through the helper).
- `activateContacts` — UPDATE `.in()` chunked via `chunkList` loop.
- `getContactEmailLookup` — unbounded select → `paginateAll` + `.order("id")` (range pagination requires a stable order; today's implicit order is unspecified).
- `getRelationshipsOnTrack` — unbounded contacts select → `paginateAll` + `.order("id")`.
- `getActivityHeatmap` — all 5 unbounded selects → `paginateAll` (bulk imports push `newContacts` past 1000 in-window rows today) with preserved error-tolerance.
- `getNetworkingStreak`, `getHomeCoreData` contacts select — same class, same modules, paginated.
- `getContactsWithLastTouch` — its inline verbatim copy of buildLastTouchMap is replaced by a call to it (dedupe + chunking in one move). Its deliberate `.limit(500)` on contacts is preserved.
- `getContacts` — hand-rolled PAGE=1000 loop replaced by `paginateAll` (identical chain/semantics). `getContactsStreamed` keeps its custom variable-page loop (small first paint page) — pinned by contacts-streamed-query.test.ts.
- Deliberate `.limit()`s (getMeetings 200, getAllInteractions 500, getEmailsForContact→deleted) preserved.

## Tests (rule 3)

- **New** `src/__tests__/data-postgrest-helpers.test.ts`: `chunked` correctness over >1000 ids (exit criterion), `chunkList` boundaries, `paginateAll` multi-page + null-page + short-page stop, `escapeIlike` (absorbs search-helpers.test.ts, which dies with its file).
- **New** `src/__tests__/data-client-seam.test.ts`: `setDataClient` routes `db()` to the injected client and back after `setDataClient(null)`; browser factory not invoked while injected; `must()` throws the PostgrestError / passes data / preserves maybeSingle null.
- **Updated** `health-queries-active-only.test.ts`: import `getContactsWithLastTouch` from `@/lib/data/follow-ups` (barrel no longer exports it).
- Everything else (compose, onboarding, streamed, tier counts, home-recent) passes unchanged — verified mock-compat above.
- `types.ts:125` JSDoc pointing at deleted `getContactsDueForFollowUp` re-pointed at `getHomeCoreData`.

## Non-goals

- No MCP db.ts collapse onto the data layer (CAR-151), no company-queries seam retirement (CAR-151 owns the fork), no docs copy changes (no user-visible behavior change), no migrations.

## Verification

From `careervine/`: `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npm run test`, `npx next build`. Exit checks: `rg 'supabase\.from' src/lib/queries.ts` → zero; `rg -c 'export function escapeIlike|export function chunk'` → one home; importers unchanged (`git diff --stat` shows no app/component churn beyond the re-points listed). Then PR `(CAR-146)`, `/deep-review-pr`, fix everything verified including nits, re-run all gates.
