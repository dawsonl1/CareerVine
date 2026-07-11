# CAR-77 — Onboarding: instant company list from bundle stats, sync progress on top, Select gated until sync completes

## Context

The guided onboarding blocks the user on a full-screen progress modal for the
entire bundle sync. The company picker only *needs* the sync because its data
source is the user's synced contacts — but every number it shows is a property
of the bundle, knowable the moment the subscription row exists. Dawson's
decision (2026-07-11): show the company list immediately, progress bar at the
top of that modal, and **gate Select until the sync completes** so the company
page a user lands on is always fully populated.

## Changes

### 1. Migration — `20260711170000_bundle_company_stats.sql`

`bundle_company_stats(p_bundle_id int)` returning per-company
`(company_id, name, logo_url, prospect_count, alumni_count,
product_alumni_count)`:

- `bundle_companies` (live memberships) joined to `companies` for name/logo.
- Counts grouped from live `bundle_prospects` payloads via the CANON-mapped
  `current_company` name (case-insensitive match against `companies.name`) —
  the same exact-by-construction technique as `bundle_alumni_stats` (CAR-61).
- Alumni = education array contains a BYU school (same LIKE predicate as
  CAR-61); product = alumni with persona in
  `('alum_product','product_leader','product_peer')`.
- SECURITY INVOKER: the existing subscriber-only RLS on
  `bundle_prospects`/`bundle_companies` scopes it — non-subscribers get zero
  rows, no new exposure. GRANT EXECUTE to authenticated + service_role.
- Rule-32 rolled-back production apply before push.

### 2. Picker data source — `src/lib/onboarding/company-picker.ts`

`getPickerCompanies(bundleId)` now calls the RPC and maps/sorts client-side
(alumni desc → product alumni desc → contact count desc → name). Drops the
user-contacts + `user_company_alumni_counts` pair for the onboarding surface —
one source before AND after the sync, so counts never flicker mid-flow.
`alreadyTargeted` was unused by the UI and is dropped from the type.

### 3. Onboarding flow — merge sync + picker into one modal

- `CompanyPickerStep` renders for BOTH `syncing` and `pick_company` states.
  While `syncing`: slim progress header (bar + "N of M added" + notice line),
  compact Gmail/Calendar connect chips, and Select buttons disabled with a
  "finishing your import" hint. On completion the flow advances to
  `pick_company` — same modal, header becomes a done line, Select enables.
- Sync driving (subscribe + `runBundleApplyLoop`) moves into the merged step,
  unchanged semantics (resume-safe, background-handoff message, unmount
  guard).
- **Progress source**: a single 2.5s poll loop reads the subscription's
  `bundle_subscription_contacts` count (RLS-scoped head count) and the
  durable `synced_version >= version` completion signal. Progress shown =
  max(apply-loop applied, DB count) — smooth regardless of which driver runs
  the sync, and independent of CAR-78's coarser per-call progress.
- State machine, persistence, skip/escape hatches, OAuth-return guard: all
  unchanged.

### 4. Docs (rule 34)

`careervine/public/docs/index.html`: update the onboarding step-2 copy
("Import while you connect") to describe picking the target company while the
import streams in, Select unlocking at completion.

## Tests

- New: company-picker mapping/sorting unit tests (RPC row → PickerCompany,
  ordering, empty result).
- Update any onboarding-flow tests touched by the merged step; keep
  `onboarding-state` suites green (state machine untouched).
- `npm run test` + `npm run build` from `careervine/`.

## Non-goals

Sync speed (CAR-78, separate PR). Settings → Data subscriptions surface
(keeps its own progress UI).
