# 24 — Company Pages, Office Locations & LinkedIn-Scrape Import

> **Rev 2.** Audited by two fresh-context review agents (code-level audit
> against actual migrations/routes + conceptual-gap review). This revision
> incorporates all confirmed findings. Key corrections vs Rev 1: merge (not
> delete-and-reinsert) import semantics, prospect/active contact segregation,
> companies UPDATE RLS policy, company_locations RLS, target-company list
> import, staleness timestamps, bounce handling, stage overrides, and a
> harvestapi→CareerVine field mapper (the schemas do NOT map 1:1).

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
  (On-site/Hybrid/Remote — often absent on older entries), **per-role
  `location`** (free text, e.g. "Greater San Diego Area"),
  `startDate`/`endDate` (`{month, year, text}`, `endDate.text === "Present"`
  for current), `description`, `skills`.
- `education[]` — `schoolName`, `schoolLinkedinUrl`, `degree`,
  `fieldOfStudy`, `startDate`/`endDate`.
- Email (Full+email mode): **exact output field name not yet verified** —
  confirm during pipeline shakedown. Reviewed profiles arriving at
  CareerVine also carry pipeline-added fields: persona, review note,
  source search, email_source.

### What CareerVine already has (audit-verified, no work needed)

- Normalized model: `companies` (global, UNIQUE(name)), `contact_companies`
  (title, `is_current`, `start_month`/`end_month` text; legacy
  `start_date`/`end_date` are unused), `schools` + `contact_schools`,
  `contact_emails`, `contact_phones`, tags, `locations` (city/state/country
  UNIQUE, shared-read/authenticated-insert RLS).
- Single-profile import: `api/contacts/import` + `src/lib/import-helpers.ts`
  (extension-auth, licdn-only photo download).
- **Email fully built**: Gmail OAuth send, compose modal, inbox sync with
  `email_messages.matched_contact_id` + `direction`, drafts, templates,
  scheduled send (QStash), follow-up sequences with auto-cancel-on-reply,
  AI drafting.
- Stage-signal tables all exist as needed: `calendar_events` +
  `calendar_event_contacts`, `meetings` + `meeting_contacts`, `referrals`,
  `interactions`, `follow_up_action_items` (due/priority/snooze).

### Known code realities the implementation MUST respect (from audit)

- The import path runs on a **user-token anon client** (never service-role):
  RLS-blocked UPDATEs affect 0 rows **silently**. `companies` currently has
  SELECT + INSERT policies only — no UPDATE.
- Existing import idempotency = **delete-all-and-reinsert** of
  `contact_companies`/`contact_schools` per contact; the unique index on
  `(contact_id, company_id, start_date)` is dead (start_date always NULL,
  NULLs distinct) — there is **no usable upsert conflict key**.
- `linkedin_url` dedupe is exact string equality; **no normalization exists
  anywhere** (trailing slash / www / case → duplicate contacts).
- Two divergent find-or-create-company implementations exist:
  `queries.ts findOrCreateCompany` (case-sensitive eq) and the import route
  (unescaped `ilike` — `%`/`_` act as wildcards). Must consolidate.
- `database.types.ts` is **hand-maintained** and already drifted: phantom
  `contact_companies.location` column; `referrals`, `calendar_events`,
  `calendar_event_contacts`, `user_companies`, `user_schools` types missing.
- `getContacts(userId, limit = 500)` silently truncates; contacts page,
  calendar, meetings, action-items all call it.
- First-touch suggestions fire for every never-contacted contact created in
  the last 30 days; import default-notes make contacts eligible for LLM
  suggestion slots too.
- `email_messages.is_simulated` marks fake onboarding replies; `direction`
  is nullable.
- Repo deploys on Vercel hobby plan — long request wall-clock is a hard
  constraint; bulk work must be chunked.

---

## Phase 1 — Migration (one file, `supabase/migrations/`)

Per repo rules: migration file only; Dawson applies with `supabase db push`.

### `companies` — metadata + missing UPDATE policy

- Add `linkedin_company_id` text NULL (stable numeric id from
  `experience[].companyId`; **primary join key**; unique partial index
  WHERE NOT NULL), `linkedin_url` text NULL, `universal_name` text NULL,
  `domain` text NULL, `logo_url` text NULL.
- **Add `companies_update_authenticated` RLS policy** (FOR UPDATE,
  `auth.uid() IS NOT NULL`) — without it, claiming existing name-only rows
  by backfilling `linkedin_company_id` silently no-ops. Companies are
  global shared facts; authenticated update matches the existing
  insert-authenticated stance.

### `company_locations` — auto-managed office registry (WITH RLS)

- `id`, `company_id` FK (cascade), `location_id` FK → locations, `source`
  text CHECK (`'scraped' | 'manual'`), `created_at`;
  UNIQUE (`company_id`, `location_id`).
- **RLS: ENABLE + select-all + insert-authenticated + delete-authenticated**
  (mirrors `locations` pattern; delete needed for office correction).
  Importer inserts with ON CONFLICT DO NOTHING (no UPDATE policy needed).
- Rows created automatically by import rule 1; manually seedable; anchor for
  location-scoped intel. Office deletion cascade: dependent
  `contact_companies.location_source='profile_match'` rows are nulled (see
  Phase 3 office management).

### `contact_companies` — per-employment location, provenance, staleness

- `location_id` int NULL FK, `location_source` text NULL CHECK
  (`'experience' | 'profile_match' | 'manual'`), `location_raw` text NULL,
  `workplace_type` text NULL CHECK (`'on_site' | 'hybrid' | 'remote'`),
  `employment_type` text NULL.
- `source` text NOT NULL DEFAULT `'manual'` CHECK (`'scraped' | 'manual'`)
  — row-level provenance; **required by the merge engine** (only
  scraped-sourced rows may be auto-removed/updated by re-imports).
- `scraped_at` timestamptz NULL — when this employment fact was last
  confirmed by a scrape.

### `contacts` — provenance, staleness, network segregation

- `headline` text NULL, `persona` text NULL CHECK (`'alum_product' |
  'alum_other' | 'product_peer' | 'product_leader' | 'recruiter'`),
  `review_note` text NULL, `import_source` text NULL
  (e.g. `apify:search_a:2026-07_tranche1`).
- `public_identifier` text NULL (LinkedIn slug — secondary dedupe key).
- `last_scraped_at` timestamptz NULL — powers "data as of" display and
  staleness auditing. Impossible to backfill later; nearly free now.
- **`network_status` text NOT NULL DEFAULT `'active'` CHECK
  (`'active' | 'prospect'`)** — bulk imports land as `prospect`:
  **excluded from first-touch/LLM suggestion generation, network-health
  coloring, and the default contacts view** (toggle to include).
  Auto-promoted to `active` on first outbound email, logged interaction, or
  meeting. This is the guard that keeps 400–1000 imported strangers from
  degrading the hand-curated-network UX.
- `stage_override` text NULL — manual escape hatch for the derived stage
  (e.g. outreach happened via LinkedIn DM; see Phase 3).

### `target_companies` — the recruiting layer (user-scoped)

- `id`, `user_id` FK, `company_id` FK, UNIQUE (`user_id`, `company_id`).
- `priority_score` numeric NULL, `tier` text NULL, `tranche` text NULL,
  `app_window_opens` date NULL, `app_window_closes` date NULL,
  `status` text NOT NULL DEFAULT `'researching'` CHECK (`'researching' |
  'outreach_active' | 'applied' | 'interviewing' | 'closed'`),
  `created_at`, `updated_at`. RLS: owner-only (standard pattern).

### `target_company_notes` — timestamped recruiting-intel log

- `id`, `target_company_id` FK (cascade), `note` text NOT NULL,
  `location_id` int NULL FK, `created_at`. RLS via parent `user_id`
  (matches the contact_emails-via-contacts pattern).

### `contact_emails` — provenance

- `source` text NOT NULL DEFAULT `'manual'` CHECK (`'manual' | 'scraped' |
  'pattern_guessed' | 'verified'`).
- `bounced_at` timestamptz NULL (set by Phase 4 bounce detection).
- Source lifecycle is **monotonic**: verified > scraped > pattern_guessed;
  re-imports may upgrade, never downgrade.

### `suppressed_imports` — deletion tombstones

- `id`, `user_id` FK, `linkedin_url` text (canonical form), `created_at`;
  UNIQUE(`user_id`, `linkedin_url`). Row written when Dawson deletes an
  imported contact; bulk import checks it and skips + reports, so deleted
  junk doesn't resurrect on the next tranche/refresh. Owner RLS.

### Types file

`database.types.ts` is hand-maintained — **hand-extend** it: add all new
columns/tables, add the missing `referrals`/`calendar_events`/
`calendar_event_contacts` types (needed by Phase 3), and delete the phantom
`contact_companies.location` entry. (A true `supabase gen types` run can
happen on Dawson's machine later.) Extend `Contact` in `src/lib/types.ts`.

## Phase 2 — Import path

### 2a. harvestapi → CareerVine mapper (`src/lib/scrape-mapper.ts`)

The schemas do NOT map 1:1 — dedicated, tested mapper module:
`firstName + lastName` → `name`; `linkedinUrl` → canonical `linkedin_url` +
`public_identifier`; `location.parsed` → city/state/country;
`experience[].position` → title, `companyName` → company (+
`companyId`/`companyLinkedinUrl`/`companyUniversalName` carried through);
`startDate {month, year}` → `"Mon YYYY"` `start_month`;
`endDate.text === "Present"` → `is_current` + `end_month = "Present"`;
`workplaceType` "On-site/Hybrid/Remote" → `on_site/hybrid/remote`;
`education[].schoolName/fieldOfStudy/startDate.year` →
school/field_of_study/start_year; email field per shakedown finding.

### 2b. Canonicalization + shared helpers (consolidation)

- **linkedin_url canonicalizer**: lowercase host+slug, strip trailing slash
  and query, force `https://www.linkedin.com/in/<slug>`. Used by bulk
  import AND retrofit into the extension route + check-duplicate. One-time
  normalization pass over existing `contacts.linkedin_url` rows (script or
  migration DO block). Dedupe order: canonical linkedin_url →
  public_identifier.
- **One find-or-create-company helper** replacing the two divergent
  implementations: match by `linkedin_company_id` first; else
  normalized-name match (trimmed, escaped ilike — the current route's
  unescaped ilike treats `%`/`_` as wildcards); on name-match with a
  scraped companyId in hand, **claim the row** by writing
  `linkedin_company_id` (requires the Phase 1 UPDATE policy); else insert.
- **One location lookup helper** wrapping the NULL-aware locations lookup
  currently duplicated in queries.ts and the import route.

### 2c. Location normalizer (`src/lib/location-normalizer.ts`)

- Deterministic string → canonical **metro-grain** `locations` row, via
  alias map in code ("Greater San Diego Area", "La Jolla, CA" → San Diego).
- **Classifies granularity**: only city/metro-grain results may establish
  offices. Country/state/region-grain strings ("United States",
  "California", "EMEA") normalize for display but return
  `can_establish_office: false`. Strips "(Remote)" markers; remote signal
  from `workplaceType` OR a "remote" token in the location string.
- Unparseable → NULL + raw kept. Shared by bulk import and extension route.

### 2d. Employment-location inference rule (the agreed spec)

Per employment record at import time:

1. **Experience entry has its own city/metro-grain location** → normalize,
   store (`location_source='experience'`), upsert `company_locations`
   (establishes the office).
2. **No experience location, profile has one** → normalize profile
   location; if it matches an office **already in `company_locations`** for
   that company → store (`location_source='profile_match'`).
   **Current roles only** — a profile location is evidence only for where
   someone works now.
3. **Otherwise** → employment location NULL; person keeps profile location
   on `contacts.location_id`; no office invented.

Rule-2 matching **re-normalizes location strings at match time** (existing
`contacts.location_id` rows predate the normalizer — e.g. a "La Jolla" row
vs a metro-grain "San Diego" office; raw ID equality would silently miss).
Remote roles: `workplace_type='remote'`, no office assignment.

### 2e. Merge engine (replaces delete-and-reinsert — audit blocker)

The existing route's replace pattern would wipe manual employment
locations, manual title/date fixes, and (via `buildUpdateData`) overwrite
notes. The bulk importer merges instead:

- **Employment natural key**: (contact, company identity, title,
  start_month). Match incoming experience entries to existing rows on it.
- Matched row → field-level update; **scraped never overwrites manual**:
  `location_source='manual'` locations win; scraped fields refresh
  `scraped_at`. Unmatched incoming → insert (`source='scraped'`).
  Existing rows absent from the new payload → delete **only if
  `source='scraped'`** (manual rows always survive).
- Multiple stints (two Google rows, different start_month) and concurrent
  roles (FT + advisor; multiple `is_current=true`) are **legal** — the
  natural key keeps them distinct; company pages render all current titles,
  most recent start first.
- Notes: append-only (reuse `append_contact_note` RPC semantics), never
  wholesale overwrite. Persona: **never overwrite a non-null persona with a
  different value on re-import** — keep existing, report the conflict in
  the import response (alum_* set by Search A should not be clobbered by a
  Search C `product_peer`).
- Emails: monotonic source upgrade only. `contacts.last_scraped_at`
  refreshed on every merge.

### 2f. Bulk people import — `POST /api/contacts/bulk-import`

- Accepts an array of reviewed profiles (harvestapi JSON + pipeline fields:
  persona, review_note, import_source, email, email_source).
- **Chunked**: pipeline sends ~25–50 profiles/POST (Vercel hobby wall-clock
  limit; photo downloads alone are up to 5s each). Photos: best-effort with
  a tight per-request photo budget — skip and report, importable later.
- **Two-pass within a chunk + office preload**: rule 1 across the chunk
  first (establish offices), then rule-2 matching against DB + chunk
  offices. Cross-chunk order effects are mopped up by the rule-2 backfill
  (2h) which the pipeline script calls once after all chunks.
- Checks `suppressed_imports` (skip + report). Idempotent via canonical
  linkedin_url / public_identifier + merge engine.
- Imports full `experience[]`/`education[]` — past employers create company
  rows (powers "previously worked at X" everywhere).
- Response: per-profile results (created/updated/skipped-suppressed/
  persona-conflict/photo-skipped, offices established) — honest logging,
  and the skip list feeds the pipeline's kept-list hygiene.
- **Auth**: user-token client (RLS intact). The pipeline script obtains a
  Supabase access token via the auth API (password grant with Dawson's
  creds from env, or stored refresh token) — document exactly this in the
  pipeline repo's `load_to_careervine.py`; "session cookie" is not a thing
  scripts have. Validate emails on the create path with the same
  regex/length rules the update path uses.

### 2g. Target-company list import — `POST /api/target-companies/bulk-import`

Goal (c) needs the 337-company list in the DB **before** people arrive:
accepts `[{name, linkedin_url?, linkedin_company_id?, priority_score, tier,
tranche, app_window_opens?, app_window_closes?}]`, find-or-creates
`companies` rows (2b helper), upserts `target_companies` per user. Fed from
APM_Company_List.xlsx by a small pipeline-repo script. Hand-entering 337
rows through a UI was never going to happen.

### 2h. Rule-2 backfill + re-normalization (re-runnable, admin endpoint or script)

- Backfill: for **`is_current`** `contact_companies` rows with NULL
  location and a contact profile location, re-attempt rule 2 against
  current `company_locations` (new offices claim earlier unmatched people).
- Re-derive: when the alias map improves, re-normalize from `location_raw`
  for `location_source='experience'` rows (never `manual`), updating
  offices accordingly.

## Phase 3 — Company pages + derived stage

Stage derivation lives HERE (not Phase 4) — the pages consume it.

### Derived outreach stage (query-layer function; if a SQL view, it must be
`WITH (security_invoker = true)`)

Per contact, later signals win:

- `not_contacted` → nothing below.
- `contacted` → outbound `email_messages` (matched, `is_simulated = false`,
  direction handled defensively) **or a logged interaction** (the
  `interactions` table exists precisely for LinkedIn DMs/calls — email is
  not the only channel).
- `replied` → inbound matched email after an outbound (`is_simulated =
  false`).
- `call_scheduled` → upcoming calendar event / meeting linked to contact.
- `call_done` → past linked meeting.
- `referral` → `referrals` row (existence check, not row count — dup rows
  with NULL meeting are possible).
- `contacts.stage_override` (when set) **wins over everything** — plus a
  lightweight "mark as contacted" action in the UI. Purely-derived with no
  escape hatch is elegant and wrong.
- `bounced` (Phase 4 signal) → surfaced distinctly, never as "no reply".

Company-level `applied`/`interviewing` stay manual on
`target_companies.status`.

### Queries (`src/lib/queries.ts`)

- `getCompanies(userId, {targetsOnly, sort, search})` — companies with
  current/former/alumni contact counts, target metadata, traction (max
  derived stage across contacts + company status). **All-companies view
  requires search + a minimum-contacts filter** — full-history import
  creates thousands of past-employer rows; an unfiltered list is a
  landfill. (Accepted risk, documented: global name-unique table can merge
  two genuinely different "Apex"s.)
- `getCompanyDetail(userId, companyId, {locationId?})` — company + target
  info + notes + location facets (distinct employment locations with
  counts, plus Remote and Unknown buckets) + people split current/former
  (title, persona, alum badge from `contact_schools` ∩ BYU school names,
  email presence + source, derived stage, `last_scraped_at`).
- Fix the `getContacts` 500-row truncation risk for this feature's scale:
  paginate or raise with explicit count surfacing; default contacts view
  filters `network_status='active'` with a "show prospects" toggle.

### Routes

- `/companies` — target-company dashboard by default: sortable by priority,
  tranche, app-window proximity, traction; toggle to all companies.
- `/companies/[id]` (numeric id; slug URLs can come later) — header (name,
  LinkedIn link, domain, target status/priority/window), recruiting-notes
  log (add note, optional location tag), **location facet chips with
  overflow** (top N + "more" — Google-scale companies produce dozens),
  honest buckets: `San Diego (4) · SF (7) · Remote (2) · Unknown (3)`,
  current-employees and former-employees sections. `?location=<id>` scopes
  people, counts, and notes.
- **Office management**: delete a `company_locations` row from the company
  page (phantom-office correction — one bad experience location otherwise
  attracts profile-matches forever). Cascade: dependent
  `location_source='profile_match'` rows → location NULL;
  `'experience'` rows keep their location (first-person evidence) but no
  longer imply an office.
- Person rows link to contact pages; compose opens the existing modal.
  "Data as of" staleness shown from `last_scraped_at`. Nav entry.
- UX bar (global rule 5): clean, facets over heavy filter UI.

## Phase 4 — Outreach hardening

- **Bounce detection in inbox sync**: NDRs arrive from mailer-daemon and
  will never match the contact by address — detect via NDR sender +
  `In-Reply-To`/original message id → set `contact_emails.bounced_at`,
  **cancel pending follow-up sequence steps** (sequences currently
  auto-cancel only on reply — they'd fire steps 2–3 into the void and burn
  sender reputation), surface `bounced` stage. At pattern-guess hit rates
  this is a third of outreach, not an edge case.
- Compose warning on `pattern_guessed` (+ "mark verified" action flipping
  source to `verified`).
- Gmail send-limit guardrail: document/enforce a daily outbound cap
  (consumer Gmail ~500/day; bursts should stay far below) in the send/
  schedule path.
- Traction sort polish on `/companies` once real stage data flows.

## Pipeline-repo integration (documented here, built there)

`load_to_careervine.py`: Supabase token acquisition (env creds → auth API),
target-company list import (2g) once per tranche, chunked people POSTs
(25–50), then one rule-2 backfill call; logs per-profile results; feeds
suppressed/skip list back into the pipeline's kept-list. The `people/` JSON
layer becomes optional.

## Build order & sizing

1. Phase 1 migration + hand-extended types — **small-medium** (types
   drift fix included).
2. Phase 2 mapper + canonicalization + merge engine + both bulk endpoints +
   backfill — **medium** (the mapper and merge engine are real modules with
   real tests; "reuse existing helpers" understated this).
3. Phase 3 stage derivation + queries + pages + office management —
   **medium** (the main UI build).
4. Phase 4 bounce handling + guardrails — **small-medium**.

Each phase: tests written/updated and passing (`npm run test` in
`careervine/`, Vitest) before commit; pull before push; README updated
(product voice) after Phase 3.

## Test coverage (per repo rules 3/4)

- Mapper: every field conversion; "Present"→is_current; missing
  workplaceType; date edge cases.
- Canonicalizer: slash/www/case/query variants → one form; dedupe by
  public_identifier fallback.
- Normalizer: alias hits, metro collapsing, granularity classification
  (country/state strings cannot establish offices), "(Remote)" stripping,
  garbage.
- Inference rule: all 3 branches; remote; rule-2 current-roles-only;
  string-level (not id-level) matching against legacy locations.
- Merge engine: manual rows survive re-import; scraped-absent rows deleted,
  manual-absent retained; boomerang stints + concurrent roles distinct;
  persona conflict preserved + reported; email source monotonicity; notes
  append-only; order-independence (shuffled batch → identical DB state).
- Bulk import: idempotent re-import (no dupes); suppression skip;
  company claim-by-companyId; escaped-ilike name matching (`%`/`_` safe);
  full-history creates past-employer companies.
- Backfill: claims earlier unmatched current roles; never touches manual;
  re-derivation from location_raw.
- Stage: each signal; interactions count as contacted; is_simulated
  filtered; override wins; referral existence not count.
- Queries: current/former split, facet counts incl. remote/unknown
  buckets, alum badge, prospect exclusion from default views/suggestions.
- Office delete cascade: profile_match nulled, experience kept.

## Verification (end-to-end)

- Import a real shakedown dataset (5-company pilot) through bulk-import;
  spot-check 10 people against LinkedIn; re-import the same batch → zero
  changes reported.
- Manually set an employment location, re-import that contact → manual
  location survives.
- Company page: current vs former correct; SD facet scopes everything;
  manually seeded office claimed by a profile-match on next import; office
  delete nulls its profile-matches.
- Import a tranche of prospects → contacts default view and suggestion
  feed unchanged; prospect promoted to active after first outreach.
- Compose to a `pattern_guessed` address shows warning; simulated NDR
  marks bounce and cancels pending sequence steps.

## Open items

- **Verify actor email output field name** during pipeline shakedown.
- BYU school-name list for alum badge: `Brigham Young University`,
  `Brigham Young University - Idaho`, `BYU Marriott School of Business`
  (extend if review shows gaps).
- Metro alias seed list: US-major-metros; expand from real scrape data.
- Company merge tool for LinkedIn-id changes on M&A/rebrand: out of scope;
  documented recipe (SQL migration re-pointing FKs) suffices for now.
- If CareerVine ever goes multi-tenant, revisit global `companies`/
  `company_locations` visibility.
