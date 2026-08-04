# Plan 27: Company Identity Dedup and Contact Count Repair

## Goal
Fix target-company contact counts (for example BD showing `0` incorrectly) by ensuring target-company rows and imported employment rows point to the same canonical `companies` record.

## Root Cause
- Target-company import resolves companies by name + URL only.
- People import resolves companies by LinkedIn `companyId` first.
- When naming differs (`BD (Becton Dickinson)` vs `BD`) and the target-company import row does not include `linkedin_company_id`, separate `companies` rows can be created.
- Company dashboard counts come from `contact_companies.company_id`, so target-company rows can appear disconnected and show `0`.

## Implementation

### 1) Harden company identity matching in app code
Update `careervine/src/lib/company-helpers.ts` (`findOrCreateCompany`) to match in this order:
1. `linkedin_company_id`
2. `linkedin_url` (normalized form)
3. `universal_name`
4. escaped `ilike` name match

Additional behavior:
- If a URL/universal-name match is found and the row lacks `linkedin_company_id`, claim/backfill it (same guarded update strategy used for name-match claiming).
- Keep current race-safe retry behavior after insert attempts.

Why:
- Prevents future split rows from target-company and people imports.

### 2) One-time migration to repair existing duplicate company rows
Add a migration under `supabase/migrations/` that:
- builds canonical-company mapping from identity keys (`linkedin_company_id`, `linkedin_url`, `universal_name`) with deterministic survivor selection (prefer row with `linkedin_company_id`, then oldest id),
- repoints foreign keys from duplicate ids to survivor ids for:
  - `contact_companies.company_id`
  - `target_companies.company_id`
  - `company_locations.company_id`
- deletes duplicate company rows after FK repointing,
- is idempotent and safe to re-run.

Conflict safety:
- use `INSERT ... ON CONFLICT DO NOTHING` patterns where uniqueness can collide during repointing (`target_companies` and `company_locations` unique constraints),
- then delete superseded rows.

### 3) Keep importer/API contracts unchanged
No request-shape changes needed now. Existing imports keep working; company resolution improves automatically.

## Verification

### Local static verification
- Typecheck/lint targeted files if available.
- Run tests (`npm run test` from `careervine/`) and ensure pass.

### Data verification queries (local DB)
- Confirm no duplicate company ids remain for the same LinkedIn identity.
- Confirm target companies that previously split (BD, HPE, BILL, etc.) now share ids with `contact_companies`.
- Confirm `/companies` aggregate counts now show non-zero where expected.

### Smoke scenario
- Re-run a small importer slice (`--only-company bd`) and verify no new duplicate company row is created.

## Rollout
- Apply and verify on local database now.
- Commit and push.
- For production later (when limits reset): `git pull` then `supabase db push`.

