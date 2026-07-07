# 24 — Company Pages, Office Locations & LinkedIn-Scrape Import

## Context

Dawson is running a PM-recruiting scraping pipeline in a separate repo (Apify
harvestapi actors: `linkedin-company-employees`, `linkedin-profile-search`).
That pipeline scrapes LinkedIn profiles per target company, agent-reviews them
one at a time, and produces reviewed-and-kept profiles. CareerVine becomes the
**system of record** for those people: look up a company, see who currently
works there and who used to, filter by office location, and run all outreach
email from inside the app.

### What the scrape data looks like (verified via Apify API + MCP)

Both actors share one output schema. Per profile:

- `linkedinUrl`, `publicIdentifier`, `firstName`, `lastName`, `headline`,
  `about`, `photo`, parsed `location` (`{city, state, country}` under
  `location.parsed`), connections/followers counts.
- `experience[]` — every job ever held: `position` (title), `companyName`,
  **`companyLinkedinUrl`**, **`companyId`** (stable LinkedIn numeric id),
  `companyUniversalName` (slug), `employmentType`, `workplaceType`
  (On-site/Hybrid/Remote), **per-role `location`** (free text, e.g.
  "Greater San Diego Area"), `startDate`/`endDate` (`{month, year, text}`,
  `endDate.text === "Present"` for current), `description`, `skills`.
- `education[]` — `schoolName`, `schoolLinkedinUrl`, `degree`,
  `fieldOfStudy`, `startDate`/`endDate`.
- Email (Full+email mode): **exact output field name not yet verified** —
  confirm during pipeline shakedown (likely `emails` or `email`; check the
  first shakedown dataset). Reviewed profiles arriving at CareerVine will
  also carry pipeline-added fields: persona, review verdict/note, source
  search, email_source.

### What CareerVine already has (no work needed)

- Normalized model: `companies`, `contact_companies` (title, `is_current`,
  `start_month`/`end_month`), `schools` + `contact_schools`, `contact_emails`,
  `contact_phones`, tags, `locations` (city/state/country, UNIQUE).
- Single-profile import: `api/contacts/import` + `src/lib/import-helpers.ts`
  (dedupe by `linkedin_url`, upserts companies/schools/emails/tags/photo).
- **Email is fully built**: Gmail OAuth send, compose modal, inbox sync with
  contact matching, drafts, templates, scheduled send (QStash), multi-step
  follow-up sequences with auto-cancel-on-reply, AI drafting. Outreach
  happens in-app; no new email infrastructure.
- Follow-up engine: `follow_up_action_items` (due dates, priority, snooze)
  covers next_action/next_action_date.
- `referrals` table exists (used for the referral stage signal).

### Gaps this plan closes

1. No company-centric view (no `/companies` route, no reverse query).
2. No per-employment location (only person-level `contacts.location_id`).
3. No target-company layer (priority, tranche, recruiting intel).
4. No bulk import path (extension endpoint is one-profile-per-POST).
5. No provenance fields (persona, email source, review note, source search).
6. No outreach stage visibility (mostly derivable from existing data).

---

## Phase 1 — Migration (one file, `supabase/migrations/`)

Per repo rules: migration files only, committed + pushed; Dawson applies
locally with `supabase db push`. Never run SQL against prod directly.

### `companies` — metadata columns

- `linkedin_company_id` text NULL — the stable numeric id from scrape data
  (`experience[].companyId`). **Primary join key for scraped data**; name
  matching is the fallback only. Unique partial index where not null.
- `linkedin_url` text NULL (canonical `linkedin.com/company/<slug>` form),
  `universal_name` text NULL (slug), `domain` text NULL (for email
  pattern-guessing sanity checks), `logo_url` text NULL.

Note: `companies` is a global shared table (no `user_id`). Fine for the
current single-user reality; company existence/offices are public facts.
Revisit RLS if the app ever goes multi-tenant.

### `company_locations` — auto-managed office registry

- `id`, `company_id` FK → companies (cascade), `location_id` FK → locations,
  `source` text CHECK (`'scraped' | 'manual'`), `created_at`.
- UNIQUE (`company_id`, `location_id`).
- Rows are **created automatically** by import rule 1 (below) and may be
  seeded manually ("I know Google has a San Diego office") so future imports
  match against them. This table is what rule 2 matches against, and the
  anchor for location-scoped recruiting notes.

### `contact_companies` — per-employment location + detail

- `location_id` int NULL FK → locations.
- `location_source` text NULL CHECK (`'experience' | 'profile_match' | 'manual'`).
- `location_raw` text NULL — the untouched LinkedIn string, for audit and
  re-derivation.
- `workplace_type` text NULL CHECK (`'on_site' | 'hybrid' | 'remote'`).
- `employment_type` text NULL (Full-time/Internship/etc. — free from scrape).

### `target_companies` — the recruiting layer (user-scoped)

- `id`, `user_id` FK → users, `company_id` FK → companies,
  UNIQUE (`user_id`, `company_id`).
- `priority_score` numeric NULL, `tier` text NULL, `tranche` text NULL.
- `app_window_opens` date NULL, `app_window_closes` date NULL.
- `status` text NOT NULL DEFAULT `'researching'`
  CHECK (`'researching' | 'outreach_active' | 'applied' | 'interviewing' | 'closed'`)
  — company-level pipeline state (applied/interviewing live here, not on
  contacts).
- `created_at`, `updated_at`. RLS: owner-only, matching existing patterns.

### `target_company_notes` — timestamped recruiting-intel log

- `id`, `target_company_id` FK (cascade), `note` text NOT NULL,
  `location_id` int NULL FK → locations (for location-specific intel like
  "SD office owns the APM program"), `created_at`.
- A dated log, not one overwritten blob — intel accumulates across calls.
- RLS via parent row's `user_id`.

### `contact_emails` — provenance

- `source` text NOT NULL DEFAULT `'manual'`
  CHECK (`'manual' | 'scraped' | 'pattern_guessed' | 'verified'`).
- Compose flow later warns before sending to a `pattern_guessed` address.

### `contacts` — scrape/review provenance

- `headline` text NULL (LinkedIn headline — high-value display field).
- `persona` text NULL CHECK
  (`'alum_product' | 'alum_other' | 'product_peer' | 'product_leader' | 'recruiter'`).
- `review_note` text NULL (the agent-review one-liner: "why this person is
  in my CRM").
- `import_source` text NULL (e.g. `apify:search_a:2026-07_tranche1`) —
  answers "which search found them"; on re-import, append/replace with
  newest, full history stays in the pipeline repo's raw archive.

Also regenerate `careervine/src/lib/database.types.ts` and extend the
`Contact` type in `src/lib/types.ts`.

## Phase 2 — Import path

### Location normalizer (shared module, `src/lib/location-normalizer.ts`)

- Deterministic string → canonical metro mapping. **Metro grain** is
  canonical: "Greater San Diego Area", "San Diego", "La Jolla, CA" → the
  same `locations` row (city = metro core city). Alias map lives in code
  (seeded with major US metros + LinkedIn "Greater X Area"/"X Bay Area"/
  "X Metropolitan Area" patterns); unrecognized strings parse as plain
  city/state, and truly unparseable ones → location NULL + raw text kept.
- Used by BOTH the bulk importer and the existing extension import route so
  rule-2 matching behaves identically everywhere. Mechanical only — no
  judgment calls, per the pipeline's code-vs-agent split.

### Employment-location inference rule (the agreed spec)

Per employment record at import time:

1. **Experience entry has its own location** → normalize, store on the
   `contact_companies` row (`location_source='experience'`), and upsert
   `company_locations` (this is what establishes an office).
2. **No experience location, but profile has a location** → normalize the
   profile location; if it matches an office **already in
   `company_locations`** for that company → store it
   (`location_source='profile_match'`). Applies to the current role.
3. **No experience location, profile location matches no known office** →
   employment location stays NULL. Person keeps their profile location on
   `contacts.location_id`; no office is invented.

Asymmetry is intentional: experience locations are evidence an office
exists; profile locations only assign people to offices we already know.
`workplaceType: Remote` → `workplace_type='remote'`, no office assignment.

### Bulk import endpoint — `POST /api/contacts/bulk-import`

- Accepts an array of reviewed profiles: harvestapi profile JSON + pipeline
  fields (`persona`, `review_note`, `import_source`, `email`,
  `email_source`). Session-auth (and/or the existing `extensionAuth`
  pattern for the pipeline script).
- **Two-pass, order-independent**: pass 1 applies rule 1 across the whole
  batch (establishing all offices), pass 2 runs rule-2 matching. Same input
  set → same output, regardless of array order.
- Idempotent: dedupe/merge by `linkedin_url` (reuse existing helpers);
  companies joined by `linkedin_company_id` first, name second. Re-import
  updates newest data, never duplicates.
- Batched Supabase ops (the single-profile route's N-sequential-calls
  pattern won't survive 400+ profiles).
- Imports the **full** `experience[]` and `education[]` arrays — past
  employers auto-create company rows, which is what powers "previously
  worked at X" for every company, targets or not.
- Response: per-profile results + counts (created/updated/skipped, offices
  established) so the pipeline script can log honestly.

### Rule-2 backfill (small, ships with the importer)

A re-runnable pass (script or admin endpoint): for `contact_companies` rows
with NULL location and a contact profile location, re-attempt rule-2
matching against the *current* `company_locations`. Run after new tranches
land — new offices established later can claim earlier unmatched people.
Deterministic because `location_source` + `location_raw` are stored.

### Pipeline-repo integration (documented here, built there)

The other repo's Phase 3 gains a `load_to_careervine.py` step that POSTs
reviewed-and-kept profiles to `/api/contacts/bulk-import`. Its `people/`
JSON layer becomes optional (raw archive + CareerVine DB cover it).

## Phase 3 — Company pages

### Queries (`src/lib/queries.ts`)

- `getCompanies(userId, {targetsOnly, sort})` — companies with contact
  counts (current/former/alumni), target metadata, derived traction.
- `getCompanyDetail(userId, companyId, {locationId?})` — company + target
  info + notes + location facets (distinct `contact_companies.location_id`
  with counts, plus remote/unknown buckets) + people, split
  current (`is_current`) vs former, each with title, persona, alum badge
  (derived from `contact_schools` ∩ BYU school names), email presence +
  source, derived stage. `locationId` filters people and counts.

### Routes

- `/companies` — list page. Default view = target companies dashboard:
  sortable by priority, tranche, app-window proximity, and traction
  (stage-progress of its contacts); shows contact/alumni counts; toggle to
  all companies (every employer in the CRM, incl. past-employer-only).
- `/companies/[id]` — detail: header (name, LinkedIn link, domain, target
  status/priority/window), recruiting-notes log (add note, optionally
  location-tagged), **location facet chips** (San Diego (4) · SF (7) ·
  Remote (2) · Unknown (3)), current-employees and former-employees
  sections. Location filter via `?location=<id>` — same page, scoped;
  facets are honest about unknowns, never pretend full coverage.
- Person rows link to existing contact pages; compose-email opens the
  existing modal. Nav entry for Companies.
- UX bar (global rule 5): clean, no clutter; facets/chips over heavy
  filters UI.

## Phase 4 — Derived outreach stage

Per contact, computed (no manual column):

- `not_contacted` → no outbound `email_messages` matched to contact.
- `emailed` → outbound matched email exists.
- `replied` → inbound matched email after an outbound.
- `call_scheduled` → upcoming calendar event / meeting linked to contact.
- `call_done` → past meeting logged.
- `referral` → row in existing `referrals`.

Company-level `applied` / `interviewing` are manual on
`target_companies.status`. Traction sort on `/companies` = max derived
stage across the company's contacts + company status. Implement as a SQL
view or query-layer function — displayed on company pages and contact rows.

## Build order & sizing

1. Phase 1 migration + types — **small**.
2. Phase 2 normalizer + bulk import + backfill — **small-medium** (reuses
   import-helpers; two-pass logic is the new part).
3. Phase 3 queries + pages — **medium** (the main build).
4. Phase 4 stage derivation + traction sort — **small-medium**.

Each phase: tests written/updated (`npm run test` in `careervine/`, Vitest)
and passing before commit; pull before push; README updated (product voice)
after Phase 3 ships user-visible pages.

## Test coverage (per repo rule 3/4)

- Normalizer: alias table hits, metro collapsing, parse fallbacks, garbage.
- Inference rule: all 3 branches; remote; two-pass order-independence
  (same batch shuffled → identical DB state); rule-2 backfill.
- Bulk import: idempotency (re-import same batch → no dupes),
  company join by `linkedin_company_id` vs name, full-history import
  creates past-employer companies, provenance fields land.
- Queries: current/former split, location facet counts incl.
  remote/unknown, alum badge derivation, stage derivation per signal.

## Verification (end-to-end)

- Import a real shakedown dataset (5-company pilot output) through
  bulk-import; spot-check 10 people against LinkedIn.
- `/companies/google` shows current vs former correctly; SD facet scopes
  everything; a manually seeded office gets claimed by a profile-match on
  the next import.
- Compose email to an imported contact with `pattern_guessed` source shows
  the warning; send works through existing Gmail path.

## Open items

- **Verify actor email output field name** during pipeline shakedown; adapt
  the bulk-import schema mapping then.
- BYU school-name list for alum badge: `Brigham Young University`,
  `Brigham Young University - Idaho`, `BYU Marriott School of Business`
  (match on `contact_schools` → `schools.name`; extend if review shows gaps).
- Metro alias seed list: start US-major-metros; expand from real scrape data.
