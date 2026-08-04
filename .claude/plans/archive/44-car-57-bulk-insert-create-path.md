# CAR-57 — First bundle sync in ~1 minute: bulk-insert the create path + bigger chunks

## Goal

Full 2,000-prospect bundle sync in ~1 minute on both drivers (interactive apply loop and QStash worker). Today: ~10s per 50-prospect chunk, dominated by the create path's ~100 sequential PostgREST roundtrips (50 `contacts` inserts + 50 per-person `contact_companies` inserts).

## Audit note — ticket premise correction

The ticket's "unique-constraint race on `(user_id, linkedin_url)`" section assumes a DB constraint that **does not exist**: the `UNIQUE (user_id, linkedin_url)` in `20260707000000_company_pages_and_scrape_import.sql` is on `suppressed_imports`, not `contacts`. `contacts.linkedin_url` has only a plain index (`contacts_linkedin_url_idx`). Consequently:

- The current per-person path has no violation-driven race recovery either (`createNewPerson` throws on any insert error) — there is nothing to replicate.
- A cross-driver race can't surface as an insert error; it would silently create a duplicate. What actually prevents that today is the sync claim serialization + the pre-chunk existing-contact lookup, and that protection is unchanged by this work.
- The per-row fallback (below) still does a refetch-then-update on insert failure, so if a unique index is ever added, recovery is already in place. Adding that index is **out of scope** (production may hold pre-existing duplicates; needs its own dedupe pass) — noted as follow-up.

## Changes

### 1. `careervine/src/lib/bulk-import.ts` — bulk-create the chunk

Restructure `importPeopleChunk`'s persistence pass (per-person loop stays for updates):

- **Loop 1 (per person, order preserved):** existing contact → `updateExistingPerson` unchanged. New contact → resolve `profileLocationId` (cached, as today), build the `contacts` insert row, defer into `pendingCreates`. `w.result` is pushed to `results` in loop order and mutated afterwards (same object reference — established pattern).
- **Bulk contact insert:** one `insert(rows).select("id, linkedin_url")`; map ids back positionally with a linkedin_url sanity check (RETURNING preserves insert order in Postgres).
- **Fallback (CAR-47 pattern — failure isolation):** bulk insert error → per-row inserts. A per-row failure refetches by `linkedin_url`/`public_identifier`; found → route through `updateExistingPerson` (status `updated`); not found → that person's result is `error`, the other 49 land.
- **Loop 2 (per created person):** set `contactId`/result fields, sink email, collect `contact_companies` rows into a new chunk-level employment list, `collectEducation`, tags, `applyTrackerState` (pipeline-only, fires only when a tracker is present).
- **Bulk employment insert:** one insert of all created-contact rows (~450 at size 50, ~1,350 at 150). On failure → per-person fallback; a person whose employment insert fails is marked `error` (same semantics as today's throw — contact exists, employment failed).
- Per-person `result.status` / `result.employment` / created-vs-updated split stay accurate; `applied_patch` remains update-path-only, so bundle fingerprint bookkeeping is untouched.

### 2. Chunk the URL-based `.in()` lookups (prereq for bigger chunks)

150–200 URL-encoded LinkedIn URLs in one `.in()` puts the GET query string near infra header limits. Bound them with the existing `chunkList` (100) and merge results:

- `bulk-import.ts`: suppression lookup, contacts by-URL, contacts by-pid.
- `bundle-sync.ts`: the pre-apply existing-contacts lookup (`.in("linkedin_url", urls)`).
- Numeric-id `.in()` lists (touch signals etc.) are fine at 150 — untouched.

### 3. `careervine/src/lib/bundle-sync.ts` — raise `SYNC_CHUNK_SIZE` 50 → 150

With per-chunk cost ~flat per row, expect ~3–4s per 150-prospect chunk → ~14 chunks for a full bundle ≈ 45–60s interactive; the worker (45s budget, 60s `maxDuration`) finishes in 1–2 invocations instead of ~8 QStash hops. Claim renewal (2-min window, renewed per chunk) keeps ample margin. The apply-route client loop and pipeline load script are cursor/size-agnostic — no changes.

### 4. Tests — extend `careervine/src/__tests__/bulk-import-batching.test.ts`

- Happy path asserts the new profile: ONE bulk `contacts` insert, ONE bulk `contact_companies` insert for the whole chunk (updated from per-person counts).
- Bulk contact-insert failure → per-row fallback; statuses stay accurate.
- Per-row insert failure + refetch hit → person lands as `updated` (race recovery path).
- Per-row insert failure + refetch miss → only that person errors; rest of chunk lands.
- Bulk employment failure → per-person fallback; failing person errors, others keep accurate `employment` counts.
- Existing tests updated where they pin the old per-person insert counts.

### 5. Verification

- `npm run test` + `npm run build` from `careervine/`.
- Live: resubscribe a test account to `apm-data-bundle`, time end-to-end on the interactive loop and a QStash-kicked background run; target ≤ ~1 min. (If a live login isn't available autonomously, surface as a manual verification note on the PR.)

## Out of scope / follow-ups

- Unique index on `contacts(user_id, linkedin_url)` + production dedupe pass (see audit note).
- Instant-return streaming UX for subscribe (ticket's "stacking UX option") — belongs to CAR-50 onboarding design.
