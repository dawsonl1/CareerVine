# CAR-269: Consolidate Adobe/Workfront and BILL/Divvy into single companies

Dawson's ask: Adobe and "Adobe (Workfront office)" are the same company; BILL and Divvy are the same company (Divvy was acquired by BILL). Hardcoding is explicitly fine. Fix his data AND the subscribable data bundle.

## Measured production state (2026-08-07)

| id | name | linkedin_company_id | employment rows | targeted | bundle member |
| --- | --- | --- | --- | --- | --- |
| 166 | Adobe | 1480 | 475 | yes (outreach_active) | yes |
| 211 | Adobe (Workfront office) | 48453 (`adobeworkfront`) | 125 | yes (researching, no notes/cycles) | yes (dup) |
| 7619 | Workfront | none | 2 | no | no |
| 249 | **"Divvy"** (misnamed; holds BILL identity: 113254, `/company/bill`) | 113254 | 355 | yes (researching) | yes |
| 701 | Divvy \| Inc. | 10593835 (`divvynowbill`) | 125 | no | no |

- 5 contacts have employment at both 166+211; 55 at both 249+701 → merges must dedupe on the CAR-261 natural key `(contact_id, company_id, title, start_month, end_month) NULLS NOT DISTINCT` before repointing.
- `companies.name` is UNIQUE; no row is currently named `BILL (Bill.com)` → renaming 249 is safe post-merge.
- Bundle 1 carries memberships for 166, 249, AND 211 (a duplicate that must go).
- **Publish-time snapshots** (`bundle_prospects.resolved` jsonb, CAR-62) store raw `experiences[].company_id` values. `bundle-fast-apply.ts` inserts `resolved_company_id` directly into `contact_companies`, so deleting 211/701/7619 without rewriting snapshots would FK-fail blank-subscriber syncs. Snapshots must be rewritten in the same transaction.
- Not touched (out of scope, distinct brands with own LinkedIn identities): `Marketo, an Adobe Company` (1886), `ProofHQ, a Workfront Company` (4692). Flag to Dawson in the summary.

## Piece 1 — hardcoded consolidation aliases (code)

`careervine/src/lib/company-helpers.ts` is the complete minting chokepoint (verified: no other code writes `companies`). Add a `CONSOLIDATED_COMPANIES` table and an exported `applyCompanyConsolidations(input: CompanyInput): CompanyInput`:

- Canonical identities: Adobe `{1480, /company/adobe, adobe}`, BILL (Bill.com) `{113254, /company/bill, bill}`.
- Alias keys → canonical: LinkedIn ids `48453`, `10593835`; universal names / URL slugs `adobeworkfront`, `divvynowbill`; normalized names (fire **only** for name-only inputs): `workfront`, `adobe workfront`, `adobe workfront office` → Adobe; `divvy`, `bill`, `bill com` → BILL.
- Rewrite replaces name+identity with canonical's and drops `logo_url` (never stamp a Workfront/Divvy logo onto the parent row).
- Apply at the top of `findOrCreateCompany` and inside `prefetchCompanies`. Prefetch must ALSO backfill the returned maps under the callers' original lookup keys (`byId` under the alias LinkedIn id, `byName` under the raw name-only key) so `bulk-import.ts`'s prefetch-hit path doesn't silently degrade to per-row round trips.

This covers every future path: extension import (name-only), MCP add_contact, contact forms, pipeline bulk load, bundle publish resolve, subscriber sync fall-through, rescrape, discovery. `payloadToMappedPerson`/`mapPeopleRecord` deliberately get NO alias logic — publish-time resolution goes through this same chokepoint, so one seam owns the rule.

## Piece 2 — merge migration (data)

New migration modeled on `20260710170000_merge_split_company_rows.sql` (the hand-verified pair-table pattern), updated where that template is stale:

- Pairs `(loser, survivor)`: (211→166), (7619→166), (701→249, rename survivor to `BILL (Bill.com)`). Environment guard on id+name so dev/CI DBs no-op.
- `contact_companies`: collide-then-repoint on the **CAR-261 natural key** (the template's `start_date` key is obsolete), plus a cross-loser dedupe pass (211 and 7619 share a survivor).
- `user_companies`, `company_locations`, `bundle_companies`, `discovery_candidates`, `scrape_runs`, `target_companies` (+ `target_company_notes`, `pipeline_cycles` repointed before loser target rows are deleted): per the template.
- **New vs template:** rewrite `bundle_prospects.resolved` snapshots — map every `experiences[].company_id` loser→survivor via a single LEFT JOIN over the pair table (a row can contain multiple losers), preserving `payload_hash` so resolutions stay hash-current.
- Recompute `data_bundles.company_count`; delete loser rows; rename 249; assertions (no losers survive, no snapshot references a loser id, rename landed).

Validation per rule 32: execute against prod inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` before the real push. Deploy order: merge PR first (alias live), then `supabase db push` — the alias must be live before the loser rows disappear so no import re-mints them.

## Piece 3 — bundle + pipeline (Drive)

- Bundle input files need no edits: `companies.json` already lists canonical Adobe + BILL (Bill.com); employment flows via LinkedIn ids which the alias now canonicalizes; `identity.company` is display-only and inert subscriber-side.
- No republish needed: existing payloads keep working (snapshots rewritten by the migration; fall-through resolution goes through the alias).
- `build_tracker.py` CANON additions (Drive, outside repo): `Workfront`/`Adobe Workfront` → `Adobe`; `Divvy`/`Divvy | Inc.` → `BILL (Bill.com)`.

## Tests

- `company-normalized-match.test.ts`: alias suite — Workfront id resolves via Adobe id; Divvy universal/url-slug resolves to BILL; name-only `Workfront`/`Divvy`/`BILL` alias; a name-alias candidate carrying an unrelated LinkedIn id is NOT aliased.
- `bulk-import-batching.test.ts`: prefetch returns alias-keyed hits (byId `48453` → Adobe row; byName `divvy` → BILL row) without breaking the existing prefetch contract tests.
- Full suite + `npm run check:conventions` + build before commit.
