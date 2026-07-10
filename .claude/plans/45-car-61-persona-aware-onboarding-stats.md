# Persona-aware onboarding stats (CAR-61)

Dawson's live-smoke corrections to the CAR-50 onboarding stats:

1. "1,420 BYU alumni **in product roles**" counted ALL alumni. Truth (from source data): 1,420 alumni total, **528 in product roles** (persona ∈ alum_product/product_leader/product_peer).
2. The companies line counted every distinct employer in alumni histories (1,079). Truth: **88 of the 99** bundle companies have ≥1 BYU alum today — reproducible only by matching CANON-mapped `identity.company` names to the bundle company list (universal-name matching reaches 10; raw fields don't align).
3. Picker badge → **two stacked counts**: total BYU alumni + alumni in product roles.

## Root cause

The bundle payload contract dropped `pipeline.persona` at publish (`payloadToMappedPerson` hardcoded `persona: null`) and never carried the canonical current employer, so neither stat was computable in SQL.

## Changes

- **Contract:** `BundleProspectPayloadV1` gains optional `persona` (5-value enum) + `current_company` (canonical name). `MappedPerson` gains optional `canonical_company` (from `record.identity.company` — stats/display only; employment rows remain raw-source per plan 24). Publish maps both out; import passes persona through; the existing fill-empty merge (`computeContactPatch`) backfills persona onto subscriber contacts on the next sync.
- **Migration `20260711010000`:** DROP+CREATE (return shapes change) `bundle_alumni_stats` → `(alumni_count, alumni_product_count, alumni_company_count)` with the company stat scoped to `bundle_companies` via `current_company` name match; `user_company_alumni_counts` → adds `product_alumni_count` (contacts.persona filter).
- **UI:** offer copy drops the false "in product roles" qualifier; progress modal shows "1,420 BYU alumni — 528 in product roles" and restores the now-true "88 of those companies…" line; picker badge stacks the two counts; product-count added as a sort tiebreaker.

## Ops after merge (Claude)

`supabase db push`, then **republish the bundle** (`scripts/publish-bundle.mjs --slug apm-data-bundle --name "APM Data Bundle" --people people-all.json --people-format people_record --companies companies.json --url https://www.careervine.app`, R2 env from .env.local) so payloads carry the new fields; verify rpc returns 1,420 / 528 / 88. Subscribers backfill persona via fill-empty on their next sync.
