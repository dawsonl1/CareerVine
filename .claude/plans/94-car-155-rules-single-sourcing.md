# CAR-155 — Rules single-sourcing: pure rule functions + one contact-write chokepoint

Wave 5 · T18 of the Straight A's program (CAR-28). Retires F8 and F9. Blocker CAR-151 merged (PR #141, in origin/main).

## Ground truth vs. ticket text (verified by code-mapping agents, 2026-07-19)

The ticket predates the CAR-151 collapse; two premises are stale:

- There is **already exactly one implementation** of each of the four rules, in `src/lib/data/follow-ups.ts` (due follow-ups :131, on-track :334, neglected :460) and `src/lib/data/home.ts` (streak :163). MCP `db.ts` imports them; no fork remains.
- `getContactsDueForFollowUp` (follow-ups.ts:207) is **not a dead shadow copy** — it is the live function behind the MCP `list_due_followups` tool. The exit criterion "getContactsDueForFollowUp no longer exists" is satisfied by **renaming** it (`getDueFollowUps`) during extraction so the historically ambiguous name is gone, not by deletion.

What genuinely remains: (a) the rules are not *pure* (fetch+compute interleaved, except `deriveDueFollowUps`), and active-only semantics live in `.eq("network_status","active")` filters at fetch call sites (follow-ups.ts:215/:291/:343, home.ts:51) rather than inside the rules; (b) the contact-write chokepoint does not exist — `createContact`/`updateContact` (contacts.ts:225/:246) are passthroughs, and canonicalization/location-normalization is done (or skipped) per call site.

## Part 1 — F8: pure rules in `src/lib/rules/`

New directory, pure functions only (no supabase imports, clock injected via `nowIso`):

- `rules/network-status.ts` — shared `NetworkStatus` type + `ACTIVE_STATUS` const + `isActiveContact()` (vocabulary today is inline string literals; DB CHECK allows `active|prospect|bench`).
- `rules/due-follow-ups.ts` — move `deriveDueFollowUps` + `DueFollowUpSourceRow`/`DueFollowUpEntry` + `getRecentCutoff` here. Add `network_status` to the source row and **filter inside the rule**.
- `rules/on-track.ts` — extract the pure core of `getRelationshipsOnTrack` as `deriveRelationshipsOnTrack(rows, nowIso)`; same internal active-only filter.
- `rules/neglected.ts` — extract the filter/sort core of `getNeglectedContacts` as `deriveNeglectedContacts(rows, nowIso)`; internal active-only filter.
- `rules/streak.ts` — extract the streak count as `deriveNetworkingStreak(activityDays: Iterable<string>, nowIso)` (streak reads activity tables, so network_status does not apply — documented in the module).

`src/lib/data/follow-ups.ts` / `home.ts` keep the fetch wrappers (SQL-level active filter stays as a performance optimization; the rule re-enforces it so a future call site cannot diverge). Rename `getContactsDueForFollowUp` → `getDueFollowUps`; update MCP `db.ts` import. `queries.ts` barrel untouched except any renamed re-exports (it does not re-export this one).

Tests: one unit test file per rule under `src/__tests__/rules-*.test.ts` (per-repo flat-test convention), including a case proving a `prospect`/`bench` row fed directly to each rule is excluded even without the SQL filter. Existing tests (`health-neglected-and-clock`, `health-queries-active-only`, `db-scoping` parity) must stay green.

## Part 2 — F9: contact-write chokepoint

Make `createContact`/`updateContact` in `src/lib/data/contacts.ts` the enforced chokepoint (every surface already calls them or will after this ticket):

1. **Inside both functions**: when the payload contains `linkedin_url`, run `canonicalizeLinkedinUrl`; canonical result when parseable, trimmed original otherwise (no silent data loss — exact behavior pinned by tests against current import-route semantics). Add bulk variants (`createContacts`) for the bulk-import path so batch inserts share the chokepoint. Optional explicit-client parameter so service-role callers (admin route) use the same functions.
2. **`findOrCreateLocation` consolidation**: single implementation in the data layer with `normalizeParsedLocation` applied **inside** (completes CAR-139/F27 structurally); `company-helpers.ts`'s duplicate delegates to it. Normalization must be idempotent (test) since import/bulk paths pre-normalize.
3. **Call-site swaps** (raw `.from("contacts")` writers → module): extension import route insert/update (`api/contacts/import/route.ts:264/:174`), admin contacts route (`api/admin/users/[id]/contacts/route.ts:164` — currently skips canonicalization entirely), apify resolver `linkContactLinkedin` (resolver.ts:157), bulk-import insert/update paths, MCP `db.ts` status/stage updates (I/J/K) via data-layer helpers. Metadata-only writers (photo, scrape counters, status re-derivation) move or get a documented allowlist entry.
4. **Point `lib/linkedin-url.ts:1-9` invariant comment at the chokepoint.**
5. **DB belt-and-suspenders** (judge's suggestion, resolved): a full SQL reimplementation of `canonicalizeLinkedinUrl` would create a second rule implementation — the exact anti-pattern this ticket retires. Instead ship a minimal `BEFORE INSERT OR UPDATE` trigger enforcing only invariants the TS canonicalizer already guarantees (trim, strip trailing slash, lowercase host) — a no-op for canonical values, a safety net for out-of-band SQL.
6. **Locations cleanup**: read-only production audit for duplicate `locations` rows that normalization would have merged ('CA' vs 'California' etc.); if found, a one-off data migration repoints FKs and deletes the dupes.

## Part 3 — Enforcement

Source-scan guard test (pattern: `architecture-boundaries.test.ts`) failing on any `.from("contacts").insert/.update/.upsert` outside `src/lib/data/contacts.ts` plus a justified allowlist; runs in the existing CI web vitest job.

## Exit criteria (restated against current reality)

- Each of the four rules has exactly one implementation under `src/lib/rules/`, each with a unit test; the name `getContactsDueForFollowUp` no longer exists in the codebase.
- Rules enforce active-only internally: prospect/bench rows are excluded even if a caller skips the SQL filter (unit-tested).
- Parity: web home data and MCP `get_network_health`/`list_due_followups` produce identical on-track %, neglected list, and due list on shared fixtures containing prospect/bench contacts (extend `db-scoping.test.ts` parity block).
- A parity test feeds www-less / trailing-slash LinkedIn URLs through web `createContact`, the extension import route, and MCP `createContactFull`, asserting identical stored values.
- 'CA' and 'California' resolve to one `locations` row from every writer (normalization inside `findOrCreateLocation`).
- Guard test proves zero out-of-band contacts writes; `npm run test` and `next build` green.

## Sequencing

1. Rules extraction + rename + unit tests (touches `src/lib/rules/*`, `follow-ups.ts`, `home.ts`, `db.ts` import).
2. Write module + findOrCreateLocation consolidation + call-site swaps + tests.
3. Trigger migration + production locations audit (+ conditional cleanup migration).
4. Guard test, full suite, build, PR. Migrations in this PR add a trigger only (no columns code reads), so rule 42's expand-first ordering is not triggered; rule 27's post-merge `supabase db push` applies.
