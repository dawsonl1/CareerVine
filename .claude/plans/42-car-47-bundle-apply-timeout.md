# Plan 41 — CAR-47: Fix bundle subscribe timeout (region + batched import engine + resilient delivery)

**Ticket:** [CAR-47](https://linear.app/career-vine/issue/CAR-47) · **Branch:** `dawson/CAR-47-bundle-apply-timeout` · **Scope decided with Dawson 2026-07-10:** options A + B + D in one PR.

## Problem

A real user (jordanfaust15@gmail.com, 2026-07-10 18:38 UTC) subscribed to the APM Data Bundle and got **zero contacts**. `/api/bundles/apply` hits Vercel's 60s `maxDuration` on chunk 1 and dies before the first contact insert.

Root cause = three multiplied factors:

1. **Work per chunk:** `importPeopleChunk` issues ~1,000 sequential DB roundtrips for one 50-prospect chunk (measured on the real bundle: 446 experiences, 255 unique companies, 157 unique locations, ~258 offices, 120 education rows — each resolved one query at a time; tags re-fetch the user's tag list per contact; education does `findOrCreateSchool` per degree).
2. **Latency per query:** functions run in `iad1` (Virginia, never configured) vs Supabase `us-west-2` (Oregon) → ~70ms/roundtrip. 1,000 × 70ms > 60s, spent entirely in the pre-pass (hence zero contacts).
3. **No recovery:** client loop has no retry; subscribe enqueues no background job (only the daily 12:00 UTC cron); cron/QStash worker run the same 50-chunk under the same 60s limit and die identically. Stuck forever.

## Fix A — colocate functions with Supabase (~1 line)

- Add `careervine/vercel.json`: `{ "regions": ["pdx1"] }`.
- `pdx1` (Portland) is the same metro as Supabase `us-west-2` → ~5–10ms/roundtrip (7–10× faster for **every** DB-touching route).
- Verified: project `rootDirectory` = `careervine` (vercel.json goes there), team is **hobby** (exactly one region allowed — fine), fluid compute on. No other keys in the file — must not touch git-deploy behavior (rule 16 history).
- Fallback if the build rejects the key: `PATCH /v9/projects/prj_olcHrQsp…` `serverlessFunctionRegion: "pdx1"` via API.

## Fix B — batch the import engine

**Files:** `careervine/src/lib/bulk-import.ts`, `company-helpers.ts`, `import-db-helpers.ts`. **Invariant: zero merge-semantics changes** — all fill-empty/fingerprint/policy logic (`scrape-merge.ts`, tested by `bundle-merge-policy.test.ts`) is untouched; only *how many queries* fetch/write the same state.

Chunk-level prefetches (each replaces an N-query loop with 1–3 queries + rare fallbacks):

1. **Companies** — new `prefetchCompanies()` in `company-helpers.ts`: one `.in("linkedin_company_id", ids)` + one exact `.in("name", names)` for id-less entries (payload schema allows name-only companies), seeding the existing `companyCache`. Misses fall through to the unchanged `findOrCreateCompany` chain (ilike/url/universal-name/insert/race-retry) — same behavior, now rare. Chunk `.in()` lists at ≤100 values/query (PostgREST selects are GETs; keep URLs bounded).
2. **Locations** — prefetch unique normalized (city,state,country) triples: one `.in("city", cities)` for city-bearing rows + one `.is("city", null).in("country", countries)` for city-less; exact key-match in memory (same eq/is-null semantics as `findOrCreateLocation`'s lookup); misses → unchanged `findOrCreateLocation`.
3. **Offices** — collect pass-1 (company, location) pairs and do ONE bulk `upsert(rows, { onConflict: "company_id,location_id", ignoreDuplicates: true })` instead of ~258 sequential `ensureCompanyLocation` calls (helper stays for other callers). Then the existing all-offices load runs as today — same net state.
4. **Schools** — chunk-level cache: one exact `.in("name", names)` prefetch; misses → unchanged `findOrCreateSchool` (keeps ilike). Created-this-run contacts skip the existing-education select (a new contact has none). Education inserts collected and bulk-inserted.
5. **Tags** — new `addTagsToContacts(supabase, userId, Map<contactId, string[]>)` in `import-db-helpers.ts`: one user-tags select, one bulk insert of missing tag names, one existing-links select for all touched contacts, one bulk link insert. `addTagsToContact` becomes a single-contact wrapper (extension import path unchanged).
6. **Emails (create path)** — collect and bulk insert once per chunk.
7. **updateExistingPerson** — receive `userId` from the caller; drop its per-contact `select user_id` roundtrip.

Kept as-is: per-person contact insert/update + employment merge (error isolation per person), suppression check, photo budget, cursor/claim protocol. **Bulk-write failure policy:** any batched insert (education/tags/emails/offices) that errors falls back to per-row writes so one bad row can't sink 49 others.

Budget after: ~120 queries/chunk (from ~1,000) → **~1–2s per chunk** with A. Rescrape (`apify/run-callback`, `cron/scrape-refresh`) and pipeline import (`/api/contacts/bulk-import`) share the engine and get the same win.

## Fix D — resilient delivery

1. **Subscribe enqueues background sync** (`api/bundles/subscribe/route.ts`): after create/reactivate, fire-and-forget `enqueueBundleSyncJobs([subscription.id], workerUrl)` (worker URL from `request.url`; QStash retries=3; `.catch` → console only — QSTASH_TOKEN confirmed present in prod). The sync no longer depends on the user's browser surviving the loop.
2. **Client loop resilience** (`data-subscriptions-section.tsx` → `runApplyLoop`): safe-parse responses (a 504 body is HTML — today that throws a raw SyntaxError at the user), retry ≤2× on 5xx/parse failure with 2s backoff, and on final failure toast "Sync will continue in the background" (now true, per D1 + cron). 409 handling unchanged.

## Tests (Vitest, from `careervine/`)

- **New:** prefetch seeding (query-count assertions per table via the repo's responder-style mock client), bulk office upsert shape, `addTagsToContacts` batching + per-row fallback, subscribe-route enqueue (on create + reactivate, none when already active, silent when QStash absent), education skip-select for created contacts.
- **Must stay green (no expected churn):** `bundle-merge-policy` (pure functions, untouched), `bundle-sync` (mocks `importPeopleChunk`), `bundle-queue`, `bundle-unsubscribe`, `bundle-payload`, `import-helpers`, `import-route`, `admin-bundles`.
- `npm run test` + `npm run build` before PR.

## Verification & remediation (post-merge — merge deploys prod)

1. Confirm region: response `x-vercel-id` prefix flips to `pdx1`.
2. Trigger Jordan's stuck sync immediately (don't wait for the noon cron): publish a QStash message to `/api/cron/sync-bundles` (arrives QStash-signed).
3. Verify: `bundle_subscriptions` id 3 reaches `synced_version = 3` with `last_synced_at` set; user `50df25ca-…` has ≈2,000 contacts; spot-check one contact's employment/tags/education; Vercel runtime errors stay clean on `/api/bundles/apply`.
4. Report outcome on CAR-47. Whether to email Jordan an apology/heads-up = Dawson's call (manual-steps item).

## Risks

- **Exact-match prefetch vs ilike:** case-variant names miss the prefetch and take the old per-company path — slower, never wrong.
- **Batched writes change failure blast radius** → per-row fallback rule above.
- **`.in()` URL length** → 100-value chunking rule above.
- **vercel.json on hobby** → single-region key only; API fallback documented.
