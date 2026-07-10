# CAR-62 — Instant bundle subscribe: publish-time snapshot resolution + fast-path apply + education bulk-insert fix

## Problem

The onboarding bundle download (APM bundle: 2,000 prospects, ~17.6k employment rows,
~3.6k education rows) takes **~4 minutes** even after CAR-57's bulk create path.
Supabase edge-log analysis of today's production syncs shows exactly where the time goes:

| Cost | Evidence | Root cause |
| --- | --- | --- |
| ~61s/sync — `contact_schools` inserted **row by row** (4,277 POSTs) | 22:41 UTC sync (post-CAR-57 code) | DB unique index is `(contact_id, school_id, start_year)` but the code dedupes on `school_id\|degree\|field_of_study\|start_year`. The bundle has **153 same-school/same-start-year pairs** (double majors), so ~every chunk's bulk education insert hits a unique violation and degrades to the per-row fallback. |
| ~50–100s/sync — `companies` re-resolved per user per chunk (2,273–4,666 GETs) | both syncs analyzed | ~2,237 of the bundle's experiences carry a company `linkedin_url`/`universal_name` but **no `linkedin_company_id`**, so they skip `prefetchCompanies` (id- and name-only) and run the sequential `findOrCreateCompany` chain — for the same ~7,400 global companies, for every subscriber, every chunk, every sync. |
| Remaining | — | The merge/fingerprint machinery (touch signals, pre/post fingerprints, per-chunk claim/checkpoint/analytics) runs even for brand-new users with zero contacts, where nothing can be merged. |

## Architecture (agreed with Dawson 2026-07-10)

**Resolve once at publish; apply per-user as pure bulk inserts; keep the merge
engine for users with existing data.**

1. **Publish-time resolution** — the final step of a bundle publish resolves every
   prospect's companies/locations/schools once (creating missing global rows,
   establishing offices) and stores the resolved ids on the prospect row
   (`bundle_prospects.resolved`). Rebuilt on publish → never stale; no nightly
   rebuild needed. Existing subscribers keep updating through the existing daily
   `sync-bundles` cron.
2. **Fast-path apply** — when a subscriber has zero contacts and zero tombstones
   (every new onboarding user), skip the merge engine: build all rows from the
   resolved snapshot and bulk-insert in large batches. Target: **seconds**, not minutes.
3. **Merge path consumes resolved ids too** — delta syncs and overlapping users stop
   re-resolving companies/locations/schools per chunk.
4. **Education bulk-insert fix** — standalone win for every import surface
   (bundle, pipeline, extension, rescrape).

Explicitly rejected: parallelizing the client chunk loop (fights the sync-claim
serialization that four drivers rely on, for less gain than the above).

---

## Part A — education bulk insert + fingerprint-tag fixes (`bulk-import.ts`, `bundle-sync.ts`)

1. **Align the education dedupe key with the DB unique index** in `collectEducation`
   (careervine/src/lib/bulk-import.ts): both `existingKeys` and `sinks.educationKeys`
   switch from `school_id|degree|field|start_year` to `school_id|start_year`
   (first entry wins — the DB can only hold one row per key anyway).
2. **Flush education with an ignore-duplicates upsert**:
   `.upsert(rows, { onConflict: "contact_id,school_id,start_year", ignoreDuplicates: true })`
   so residual collisions (concurrent writers) can't poison the batch. Keep the
   per-row fallback for genuinely bad rows. NULL `start_year` rows behave like plain
   inserts under ON CONFLICT (NULLs never match) — unchanged from today.
3. **Fix the latent tag-fingerprint drift bug** in `postApplyFingerprint`
   (bundle-sync.ts): it merges **raw** payload tags (`"APM"`) into the baseline while
   `addTagsToContacts` stores normalized names (`"apm"`) and later re-reads fingerprint
   the stored names — guaranteeing false drift → false `user_touched` on the next
   delta for any updated contact with a cased bundle tag. Normalize
   (`trim().toLowerCase()`) payload tags before the union. The fast path (Part C)
   must use the same normalized names.

## Part B — publish-time resolution

### Migration `supabase/migrations/20260711020000_bundle_snapshot_resolution.sql`

- `ALTER TABLE bundle_prospects ADD COLUMN resolved jsonb, ADD COLUMN resolved_at timestamptz;`
- `ALTER TABLE data_bundles ADD COLUMN resolved_version int NOT NULL DEFAULT 0;`
  (`resolved_version = version` ⇔ every live prospect row has a hash-current
  resolution; the fast path gates on this, so unresolved bundles just take the
  merge path — graceful.)
- RPC `apply_bundle_resolutions(p_rows jsonb)` (SECURITY DEFINER, service-role
  usage only — REVOKE from authenticated/anon): one round trip updates a chunk of
  resolutions via `UPDATE ... FROM jsonb_to_recordset(...)` instead of 200 PATCHes.
- Column comments per house style.

### `resolved` shape (positionally aligned with the payload arrays)

```jsonc
{
  "payload_hash": "…",              // staleness key: re-resolve when != payload_hash
  "profile_location_id": 123,        // nullable
  "experiences": [ { "company_id": 1, "location_id": 2, "location_source": "experience" | "profile_match" | null } ],
  "education":   [ { "school_id": 9 } ]                    // null school_id = unresolvable name
}
```

### New module `careervine/src/lib/bundle-resolve.ts`

`resolveBundleChunk(service, bundle, { afterId, chunkSize=200 })`:

- Page live prospects (`removed_in_version is null`, `id > afterId`) in id order;
  skip rows whose `resolved.payload_hash` already matches.
- Resolve with the existing helpers (`prefetchCompanies` + `findOrCreateCompany`
  fallback, `prefetchLocations`/`findOrCreateLocation`, exact-name school sweep +
  `findOrCreateSchool`), sharing one cache across the chunk.
- Establish offices bundle-wide at resolve time: pass 1 (city-grain experience
  locations → `ensureCompanyLocations('scraped')`) and pass 2 (profile location
  claims a known office for current roles, DB + this run) — the same rules
  `importPeopleChunk` applies today, executed once instead of per subscriber chunk.
- Write the chunk's resolutions via the RPC; stamp `resolved_at`.
- When the cursor is exhausted and every live row is hash-current, set
  `data_bundles.resolved_version = bundle.version` and report done.

### Drivers

- **Publish route** (`/api/admin/bundles/publish`): new mode `resolve`
  (same `BUNDLE_ADMIN_TOKEN` bearer, service client, cursor in/out).
  `scripts/publish-bundle.mjs` drives it in a loop after `finalize`.
- **Safety net**: the daily `/api/cron/sync-bundles` runs the resolver to
  completion for any published bundle with `resolved_version < version`
  **before** fanning out subscription syncs — any publish path that forgets to
  resolve self-heals within a day, and the fan-out then benefits from Part D.

## Part C — fast-path apply (`careervine/src/lib/bundle-fast-apply.ts`)

### Eligibility (checked in `applyBundleDelta` when `cursor == null`)

All of: `subscription.synced_version === 0` · `bundle.resolved_version === bundle.version`
· user has **zero contacts** (HEAD count) · user has **zero `suppressed_imports`** rows.
This is exactly the onboarding population; anyone else falls through to the merge
path unchanged. (Precise "no-overlap" detection for users with a few unrelated
contacts is a possible follow-up, not v1 — the gate must be trivially safe.)

### Dispatch

Inside `applyBundleDelta` so **all four sync drivers** (user apply route, QStash
worker, daily cron, Settings self-sync) get the fast path for free:

- `cursor == null` + eligible → fast path, cursor phase `"fast"`.
- `cursor.phase === "fast"` → continue fast path (client threads the cursor back
  opaquely; `bundleApplySchema` + `SyncCheckpoint`/`readSyncCheckpoint` learn the
  third phase so worker/cron resume works).
- Otherwise → existing apply/remove phases, untouched.

### Per call (`FAST_BATCH = 1000` prospects, well inside `maxDuration = 60`)

1. Fetch live prospects ≤ pinned version with `resolved`, `id > afterId`, limit 1000.
   Unparseable/stale rows → `skipped[]` (belt; the `resolved_version` gate makes
   them rare).
2. Build every row in JS (reusing `payloadToMappedPerson` + the exported
   `buildContactInsertRow`): contacts; employment from resolved ids
   (`source:'scraped'`, `scraped_at`); education (Part A key + upsert); best email
   per prospect (`isValidImportEmail`); tags.
3. Bulk-write, minimal returns except contacts:
   contacts in batches of 500 with `.select("id, linkedin_url")` (positional +
   URL-fallback mapping, same guard as `bulkCreatePersons`); then in parallel:
   `contact_companies` (batches of 1000), `contact_schools` upsert,
   `contact_emails`, `addTagsToContacts`, `bundle_subscription_contacts`
   (`created_by_bundle: true`, versions = pin), `bundle_contact_state` with a
   **precomputed fingerprint** — computed from the exact rows we inserted
   (name/headline/notes/persona/network_status, `stage_override: null`, no manual
   rows, normalized tag names), no re-read. Parity with a later
   `fetchTouchSignals` read is REQUIRED and unit-tested (Part E).
4. Full batch → return `{ done: false, nextCursor: { phase: "fast", afterId } }` +
   checkpoint; short batch → commit `synced_version = pin` (a zero-contact user has
   nothing in the removal phase by construction), `done: true`. Emit ONE
   `contact_imported` + milestone check on completion instead of per chunk.

### Failure semantics

Any error → throw; the route releases the claim (existing behavior). The retry
re-checks eligibility, now sees contacts > 0, and the **merge path resumes
idempotently** (fill-empty on the already-inserted contacts). Known degradation,
documented in code: contacts inserted in a crashed batch before their linkage rows
land are re-linked as `created_by_bundle: false` (merge-path semantics), so
unsubscribe won't auto-delete them. Rare (a crash inside a ~5s window) and safe
(never deletes user data — errs toward keeping).

Expected result: 2,000 prospects ≈ 2 fast calls ≈ **5–15 seconds** end to end.

## Part D — merge path consumes resolved ids

- `applyBundleDelta` selects `resolved` alongside `payload`;
  `payloadToMappedPerson` gains an optional resolved argument and stamps
  per-item ids: `MappedEmployment.resolved_company_id/location_id/location_source`,
  `MappedEducation.resolved_school_id`, `MappedPerson.resolved_profile_location_id`
  (all optional — absent for pipeline/extension/rescrape callers, whose behavior
  is unchanged).
- `importPeopleChunk` short-circuits at each resolution point when the resolved id
  is present: company chain skipped (CompanyRecords bulk-fetched by id, one `.in()`
  per chunk, so `chunkOffices`/diff-capture keep real records); location passes 1–2
  skipped (resolved `location_id`/`location_source` used directly; offices were
  established at publish); `resolveSchool` skipped.
- Kills the 2,273–4,666 per-sync `companies` GETs for bundle delta syncs and
  overlapping subscribers.

## Part E — tests (Vitest, `careervine/`)

- **Education key alignment**: same school+year, different degrees → one sunk row;
  update path honors existing rows under the new key; flush uses ignore-duplicates
  upsert (mock asserts `onConflict`).
- **Tag normalization**: `postApplyFingerprint` with cased payload tags matches a
  re-read fingerprint of stored (lowercased) names.
- **Fingerprint parity (critical)**: fast-path precomputed fingerprint ===
  `computeContactFingerprint` over a simulated `fetchTouchSignals` snapshot of the
  same inserted state — guards the "bundle may later delete this contact" invariant.
- **Eligibility gates**: each condition (synced_version, resolved_version, contact
  count, tombstones) independently forces the merge path.
- **Fast-path step mechanics**: cursor threading, short-batch commit of
  `synced_version`, skipped-row reporting, batch→children row-shape parity with the
  merge path (same columns/values as `bulkCreatePersons` output for a fresh user).
- **Resolver**: chunk cursor, hash-staleness skip, `resolved_version` commit only
  when complete; office establishment parity (pass 1 + pass 2 rules).
- **readSyncCheckpoint** accepts phase `"fast"`.

## Part F — rollout & verification

1. PR (this branch), Dawson merges.
2. `supabase db push --dry-run` → review → `supabase db push` (rule 27, me).
3. Run the resolver for the live APM bundle (publish script's resolve loop against
   production with `BUNDLE_ADMIN_TOKEN`); confirm `data_bundles.resolved_version = 3`
   and spot-check `resolved` rows against payloads.
4. Verify fast path end to end with a fresh test signup; expect bundle download
   in ≤15s. Confirm in Supabase edge logs: no `companies` GET storm, no per-row
   `contact_schools` POSTs.
5. Watch the next daily cron run: delta path healthy, resolver self-heal no-ops.

## Out of scope / follow-ups

- Precise no-overlap eligibility for users with unrelated existing contacts.
- Raising `SYNC_CHUNK_SIZE` beyond 150 for the (now cheaper) merge path.
- Onboarding UX handoff (start browsing while the tail lands in the background) —
  unnecessary if the fast path hits its target.
