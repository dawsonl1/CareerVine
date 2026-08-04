# CAR-63 — Prune stale bundle company memberships on publish

## Problem

`bundle_companies` is add-only: `publishCompaniesChunk` upserts memberships
(`ignoreDuplicates: true`) but nothing ever removes a membership when a company
drops out of (or is renamed in) the source `companies.json`. The
`apm-data-bundle` has accumulated 104 memberships against a 99-company source
list — the extra 5 are name-variant company rows linked by earlier publishes
(the Domo / "Domo, Inc." class of debt). `data_bundles.company_count`
(recomputed at finalize from live memberships) and the onboarding-modal stats
inflate accordingly.

Prospects don't have this bug: `bundle_prospects` carries
`version_last_seen`, and `finalizePublish` soft-removes rows not seen in the
current run. Companies never got the equivalent.

## Consumers checked (pruning is safe)

- `finalizePublish` membership count → `data_bundles.company_count`.
- `bundle_alumni_stats()` SQL function (onboarding stats) — live read.
- RLS select policy for subscribed users — no app code selects
  `bundle_companies` directly; no per-user rows reference membership ids.
- Bundle sync / unsubscribe never touch `bundle_companies` — subscriber
  company rows come from prospect payloads, not memberships.

Membership rows are pure display/provenance links (per the schema comment in
`20260709000000_data_bundles.sql`), so **hard delete** is correct — no need to
mirror the prospects' soft-removal columns.

## Changes

1. **Migration** `supabase/migrations/<ts>_bundle_companies_version_last_seen.sql`
   - `ALTER TABLE bundle_companies ADD COLUMN version_last_seen int;`
   - Nullable, no backfill: `NULL` means "not seen since this feature landed",
     and finalize prunes it on the next publish — the first post-deploy
     republish IS the one-time cleanup of the 5 stale rows (no ad-hoc SQL).
   - Partial index not needed at this scale (~100 rows/bundle).

2. **`publishCompaniesChunk`** (`careervine/src/lib/bundle-publish.ts`)
   - Upsert now includes `version_last_seen: stagingVersion` and drops
     `ignoreDuplicates: true` so existing memberships get stamped on conflict.

3. **`finalizePublish`**
   - Before recomputing counts: hard-delete memberships for the bundle where
     `version_last_seen IS NULL OR version_last_seen < stagingVersion`
     (count-based, consistent with the CAS/count house style — rule 17).
   - Report `companiesPruned` in `FinalizePublishResult`.
   - Version-bump semantics unchanged: `hasChanges` stays prospect-driven —
     the bundle version only gates prospect sync; companies are read live.
   - Same full-snapshot semantics as prospects: a publish that stages no
     companies removes all memberships, exactly as an empty prospect publish
     soft-removes all prospects.

4. **Types** — add `version_last_seen` to the `bundle_companies` types in
   `database.types.ts` (matching generator output shape).

5. **Tests** (`careervine/src/__tests__/bundle-publish.test.ts`)
   - Chunk upsert stamps `version_last_seen` and no longer ignores duplicates.
   - Finalize deletes stale/NULL memberships and recomputes `company_count`
     after the prune; `companiesPruned` surfaces the count.

## Verification

- `npm run test` + `npm run build` from `careervine/` in the worktree.
- Post-merge: apply the migration (`supabase db push --dry-run`, then push),
  then republish the bundle via `scripts/publish-bundle.mjs` against
  `https://www.careervine.app` — expect `companiesPruned: 5` and
  `company_count` converging to 99 (source list), onboarding stats following.
