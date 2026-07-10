# CAR-34 — Add company button + create-company modal on the Companies page

## Problem

`/companies` has no way to add a company directly. CAR-18 made contact-less
companies possible, and the company *detail* page can target/office an existing
company — but creating a brand-new company still requires an import or a
contact edit. The Targets empty state even says "add one from a company page",
which is circular when you have no companies.

## Approach

Pure client-side feature — no schema changes, no new API routes. Reuses the
plan-27 identity path so manual adds can never mint duplicate company rows.

### 1. Data layer — `careervine/src/lib/company-queries.ts`

- `normalizeManualCompanyInput(input)` — pure helper: trims name, empty→null
  LinkedIn URL, detects whether a location was provided (testable).
- `addCompanyManually(userId, input)`:
  1. `findOrCreateCompany(db(), { name, linkedin_url })` (shared dedup:
     linkedin_url → universal_name → escaped-ilike name → insert w/ race retry).
  2. Ensure a `target_companies` row (skip if one already exists) so the
     company shows in the default Targets view.
  3. If a location was given, `addCompanyOfficeLocation` (existing idempotent
     office path).
  4. Return `{ companyId, created, targeted }` for toast copy + navigation.

### 2. UI — new `careervine/src/components/companies/add-company-modal.tsx`

- M3 `Modal` (size sm), fields: **Company name** (required), **LinkedIn URL**
  (optional), **Office location** city/state/country (optional, country
  defaults "United States") — mirrors the detail page's add-office form.
- Submit → `addCompanyManually` → toast (“Added X” / “X already exists —
  opened it”) → `router.push(/companies/{id})`.
- `hasUnsavedChanges` guard when fields are dirty.

### 3. Wire-up — `careervine/src/app/companies/page.tsx`

- Header: outlined **Add company** button (Plus icon) beside "Start outreach
  flow".
- Targets empty state: replace the circular copy with a real "Add a company"
  action that opens the modal.

### 4. Tests

- `company-add-manual.test.ts`: `normalizeManualCompanyInput` cases (trim,
  empty URL → null, location presence detection).
- Run `npm run test` + `npm run build` from `careervine/`.

## Out of scope

- Logo/domain enrichment for manual companies (import-only today).
- Editing company fields after creation.
