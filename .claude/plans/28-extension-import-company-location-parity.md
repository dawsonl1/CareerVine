# Plan 28: Extension Import Company-Location Parity

## Goal
Bring Chrome extension contact import location behavior in line with the pipeline bulk import so company pages and office/location facets remain consistent regardless of import source.

## Current Gap
- Extension import route creates/updates companies and employment rows, but does not set:
  - `contact_companies.location_id`
  - `contact_companies.location_source`
  - `contact_companies.location_raw`
  - `contact_companies.workplace_type`
- It also does not register offices in `company_locations`.

## Implementation

### 1) Reuse location normalization and office helper utilities
In `careervine/src/app/api/contacts/import/route.ts`, use:
- `normalizeLocation`, `normalizeParsedLocation`, `locationMatchKey` from `location-normalizer`
- `ensureCompanyLocation` from `company-helpers`

### 2) Add per-experience location handling (rule 1 parity)
For each experience row in extension import:
- keep `location_raw` from scraped/profile text,
- derive `workplace_type` (`remote`, `hybrid`, `on_site`, or null),
- if non-remote and city-grain location can establish office:
  - `findOrCreateLocation(...)`,
  - set `location_id`,
  - set `location_source = 'experience'`,
  - call `ensureCompanyLocation(...)`.

### 3) Add profile-match fallback for current roles (rule 2 parity)
For current roles without established employment location:
- normalize contact/profile location,
- look up known offices for that company (`company_locations` + `locations`),
- if profile location matches a known office key, set:
  - `location_id` to matched office location,
  - `location_source = 'profile_match'`.

### 4) Preserve existing extension import behavior
- Keep dedupe/replace semantics for update path intact.
- Keep contact-level `contacts.location_id` behavior unchanged.
- No schema changes/migrations needed.

## Verification
- Add/adjust tests in `careervine/src/__tests__/import-route.test.ts`:
  - experience location establishes office and sets employment location fields,
  - remote role does not establish office,
  - current role with no exp location profile-matches an existing office.
- Run `npm --prefix "careervine" run test`.

