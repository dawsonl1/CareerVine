# CAR-77 — Onboarding: instant company list from bundle stats, sync progress on top, Select gated until sync completes

## Problem

The guided onboarding (CAR-50) blocks the user on a full-screen sync progress modal for the whole bundle apply (~2 min) before showing the company picker — only because the picker's data source is the user's own synced contacts. Bundle-level data sufficient to render the list exists the moment the subscription row is created.

## Design

### 1. Migration — `supabase/migrations/20260711170000_bundle_company_stats.sql` (renumbered from 160000 after CAR-78 landed a same-version migration on main)

New SQL function `bundle_company_stats(p_bundle_id int)` returning per-company rows for a subscribed bundle:

```
company_id int, name text, logo_url text,
prospect_count bigint, alumni_count bigint, product_alumni_count bigint
```

- `LANGUAGE sql STABLE SET search_path = public` — **SECURITY INVOKER** (per ticket): `bundle_companies_select_subscribed` / `bundle_prospects_select_subscribed` RLS already scope it to active subscribers, and the picker only ever renders post-subscribe. Non-subscribers simply get zero rows.
- Shape: CTE over live `bundle_prospects` (`removed_in_version IS NULL`, `current_company IS NOT NULL`) computing `company_key = lower(btrim(payload->>'current_company'))`, `is_alum` (BYU education match, same predicate as `bundle_alumni_stats`), `is_product` (persona ∈ alum_product/product_leader/product_peer). Then `bundle_companies JOIN companies` LEFT JOIN the CTE on the CANON name match (`lower(btrim(co.name))`), `count(*)` + `FILTER` aggregates, GROUP BY company. Exact by construction (CAR-61 CANON contract).
- `bundle_companies` needs no liveness filter — stale membership rows are hard-deleted at publish finalize (CAR-63).
- `REVOKE ... FROM public, anon; GRANT EXECUTE TO authenticated, service_role` + `COMMENT ON FUNCTION`.

### 2. Client data source — `careervine/src/lib/onboarding/company-picker.ts`

- Add `getBundlePickerCompanies(bundleId)`: `supabase.rpc("bundle_company_stats", { p_bundle_id })`, inline result cast (no `database.types.ts` — repo has no Functions section by convention), map to `PickerCompany` (`contactCount ← prospect_count`), reuse the existing sort (alumni desc → product alumni desc → count desc → name).
- Extract the comparator so both sources share it. Drop the unused `alreadyTargeted` field from `PickerCompany`.
- Keep `getPickerCompanies(userId)` as the fallback for a resumed `pick_company` session where bundle stats can't resolve (bundle unpublished later — degrades instead of dead-ending).

### 3. Onboarding flow — `careervine/src/components/onboarding/onboarding-flow.tsx`

Merge `SyncProgressStep` + `CompanyPickerStep` into one modal component rendered for **both** `syncing` and `pick_company` states (same modal; only the header + Select gating differ):

- **Sync driver** (unchanged semantics, runs only when mounted in `syncing`): `subscribeToBundle` → `runBundleApplyLoop` → `finish()` on completion or hand-off to the poll. `doneRef` unmount semantics preserved. `onProgress` from the loop is no longer the bar's source.
- **Unified poll** (every ~3.5s while syncing, replaces `pollUntilSynced` and feeds the bar): reads `bundle_subscriptions (id, status, synced_version)`, `data_bundles.version`, and `count(bundle_subscription_contacts)` head-count for the subscription (RLS-scoped, cheap). Progress = `count / stats.prospectCount`. Completion = `status='active' && synced_version >= version` → `finish()` → `advance("pick_company")`.
- **Company list**: `getBundlePickerCompanies(stats.bundleId)` — first load gated on the subscribe call resolving; if empty while still syncing, retried on poll ticks (covers subscribe race).
- **Slim progress header** (syncing only): compact title + bar + "N of M added" + hint that Select unlocks when the import finishes. The big `StatLine` list goes away (the offer step already showed those numbers). Gmail/Calendar connect card stays, compacted to a single row, syncing state only.
- **Select gating**: buttons `disabled` while syncing with a "finishing your import…" affordance; enabled in `pick_company`. `onPicked` flow unchanged (`addTargetCompany` → `advance("outreach")` → company page).
- **Resume semantics unchanged**: `pick_company` renders the same modal minus the sync machinery; `not_started`/offer/finale untouched.

### 4. Docs (rule 34) — `careervine/public/docs/index.html`

Update "Guided first run" steps 2–3: companies are browsable immediately while the import streams in on a slim progress bar up top; picking unlocks the moment the import finishes.

### 5. Tests

- New `careervine/src/__tests__/onboarding-company-picker.test.ts`: `getBundlePickerCompanies` mapping + shared sort order (mock browser client rpc), empty/null RPC result handling.
- Update anything referencing the removed `alreadyTargeted` / renamed pieces; full `npm run test` + `npm run build` from `careervine/`.

## Out of scope

Sync speed itself (RLS initplan wrap, server-side apply loop, deferred analytics) — companion ticket.

## Verification

Vitest + build; migration validated at merge time via `BEGIN; SET LOCAL lock_timeout='3s'; …; ROLLBACK;` against production (rule 32) before `supabase db push`.
