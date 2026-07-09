# 29 — Scrape-Diff & Find-Email (CAR-15)

**Status:** Rev 3, 2026-07-09 — audited. Rev 2 was audited by two agents: a UI-grounding pass
(mapping every proposed feature onto real components) and an adversarial technical audit
(verifying every claim against the code). Rev 3 folds in all findings. Implementation still
blocked on §9.
**Linear:** [CAR-15](https://linear.app/career-vine/issue/CAR-15/explore-benefits-of-a-weekly-or-bi-weekly-or-monthly-appify-contact) (In Progress).
Spun out: [CAR-29](https://linear.app/career-vine/issue/CAR-29/discovery-feed-surface-new-pm-hires-at-target-companies) — out of scope.
Pricing verified live at BRONZE tier 2026-07-08.

## 1. Scope of this increment

**In:**
1. **Enrich never-scraped contacts** — extension saves (no photo/email, AI-parsed employment) and manual adds (may lack `linkedin_url`).
2. **Cadence re-scrape + diff** of known contacts → outreach-worthy change suggestions.
3. **Find-email** — event-driven (on company change) + on-demand per contact.
4. **Work-anniversary touchpoints** from stored `start_month` — no scraping (less "free" than Rev 2 claimed; see §6.4).

**Out:** new-people discovery → CAR-29; company-employees monitoring (rejected, §2); third-party email vendors (one optional exception, §4).

## 2. Actor decisions (settled)

All three HarvestAPI candidates return the identical full-profile payload and share per-profile
events ($0.004 full / $0.01 full+email, no start fees). They differ only in addressing:

| | A. `linkedin-profile-scraper` | B. `linkedin-profile-search-by-name` | C. `linkedin-profile-search` |
| --- | --- | --- | --- |
| Addressing | exact URL / public identifier | name + filters (company, location, school) | filters only — can't target a person |
| Search-page fee | none | $0.004 (≤10 short profiles) | $0.10 (≤25 short profiles) |
| Typical unit | $0.004/contact | ~$0.008/lookup ($0.014 w/ email) | ≥$0.10/query + $0.004/profile |

- **A is the engine** — every scrape in this increment. We store `linkedin_url` + `public_identifier`.
- **B is the fallback resolver only**: (1) manual contacts with no URL — `strictSearch` +
  `currentCompanies`/`locations` disambiguators, auto-accept single-match only; (2) URL-rot repair
  after repeated A failures.
- **C is unused here** (discovery lane; powers pipeline Search A/B and CAR-29). For monitoring known
  contacts it loses outright: $0.10/page firehose that can't be scoped to our fleet vs $8 to re-scrape
  the whole fleet exactly.

**Rejected:** `linkedin-company-employees` (2× price + $0.02/company start; only lists *current*
employees — structurally misses leavers); cheap email-only actors (unverified, second vendor;
optional exception in §4).

## 3. Cost model & cadence

**Fleet** (measured 2026-07-08): 2,000 pipeline people-records — 1,566 `target_company`,
325 `broad_network`, 109 missing scope (default to `target_company` on import). ~240 in prod so far
(loader re-run pending). 78% already have verified emails; the 439 without already failed one email
search. 1,635 have photos. Extension-saved `active` contacts: small count, never scraped.

| Cadence (fleet = 2,000, profile-only, actor A) | Monthly cost |
| --- | --- |
| Weekly | ~$34.70 |
| Biweekly | ~$17.30 |
| **Monthly (recommended base)** | **$8.00** |
| Tiered: ~300 hot biweekly + rest monthly | ~$9.40 |

**Recommendation: monthly fleet-wide + biweekly hot subset** (prospects at target companies with
`next_app_date` ≤ ~60 days, or derived stage ≥ contacted). Job-change base rate ~1–2%/mo → monthly
catches changes with ~2-week lag, inside the congrats window. **Steady state ~$9–11/mo**, within the
Starter plan's $39/mo credit.

**Required throughput (Rev 3 correction):** the daily drip must process **~75–90 profiles/day**
(1,700 monthly ÷ 30 + 300 hot × 2/mo ÷ 30 ≈ 77/day), not Rev 2's "25/day" (which is an 80-day
cycle, not monthly). Never-scraped contacts (`last_scraped_at IS NULL`) sort first.

**Per-contact button:** no start fee ⇒ singles cost the same per profile as batches. Design for UX
(7-day `last_scraped_at` debounce), not price. Never run cadence scrapes in email mode.

## 4. Email strategy

Email search is charged **per attempt** ($0.01, found or not; results SMTP-verified). The 439
email-less contacts already failed once — blind retry ≈ $4.39 of repeat failures. Instead:

1. **Never-scraped contacts:** first scrape in email mode — one $0.01 run fills photo + employment + headline + verified email.
2. **Previously-failed contacts:** re-attempt **only on detected company change** (new employer = new domain = fresh chance).
3. Optional: `vulnv/linkedin-email-finder` pay-per-found ($0.028/found) beats pay-per-attempt below ~36% hit rate — only if harvestapi retry yield proves poor.

**Audit fixes (Rev 3):**
- The synthetic-record wrapper must set `crm.email` + `crm.email_source: 'verified'` explicitly —
  the mapper's raw-`emails[]` fallback assigns `'scraped'` (`scrape-mapper.ts:305-308`), one rung
  below the actual SMTP-verified trust level.
- **Bounce interaction** (Rev 2 claimed `bounced_at` handling exists in scrape-merge — it doesn't;
  bounce refusal lives in `email-send.ts`). Rules: re-finding an address with `bounced_at` set does
  NOT clear the bounce (record a change event instead, let Dawson judge); a **new distinct** address
  found for a contact whose primary is bounced is inserted and **promoted to primary** (today
  `is_primary: !hasPrimary` would leave the bounced address primary).

## 5. Diff engine spec

**Rev 3 correction:** `employmentKey` in scrape-merge uses the internal **`company_id` FK** —
not `linkedin_company_id` as Rev 2 claimed — and extension-created companies have **no**
`linkedin_company_id` at all (extension import creates by name only). The diff cannot naively reuse
merge-plan output. Spec:

- **Pure function** `computeDiff(existingState, mappedPerson) → ChangeEvent[]`, run before any
  persistence, tested like scrape-merge (pure module + Vitest).
- **Company-level pairing:** group employment rows by resolved `company_id`; within a company,
  compare titles/dates → distinguishes *promotion* (same company, new current title) from
  *company change* (current role at a previously-unseen company). Title/start-date edits must not
  read as changes (pair on company first, never on the full `(company, title, start_month)` key).
- **False-positive guard:** claim Tier-1 "company change" only when both old and new companies carry
  `linkedin_company_id`s that differ. If either side lacks the id (extension-created company rows),
  downgrade to a Tier-3 "employment updated" data refresh — never a congrats prompt off a possible
  name-mismatch ("Domo" vs "Domo, Inc.").
- **Read path:** `importPeopleChunk` has no pre-merge hook and its company resolution
  (`findOrCreateCompany`) already writes rows. Add a diff callback between company resolution and
  persistence (preferred) rather than a separate read-pass that duplicates company matching.
- **Noise rules:** old value null/absent ≠ change (explicitly including **booleans** — a contact
  already `openToWork: true` at first snapshot produces no event); exclude `photo_url` (its
  cache-bust timestamp churns every scrape); dedupe events on `(contact_id, type, hash(new_value))`
  so an unpersisted change (see location, below) can't re-fire monthly; respect
  `suggestion_cooldown_until`.
- **Location:** `computeContactPatch` only fills `location_id` when empty ("manual wins"), so a
  location change would diff forever without persisting. Fix: allow scraped→scraped location refresh
  (contact-level location provenance), plus the event dedupe above as backstop.
- **Signal fields:** `hiring`, `openToWork` (verified present in raw payloads, verified dropped by
  the mapper today) come from the snapshot table (§7) — they are persisted nowhere else.

### Taxonomy (unchanged from Rev 2)

- **Tier 1 — act now (→ suggestions):** company change (also triggers email re-search §4);
  promotion; `hiring` flips true; `openToWork` flips true.
- **Tier 2 — touchpoints:** new certification/degree; location change; work anniversary (no scrape).
- **Tier 3 — silent refresh:** photo, headline/about, skills, follower counts.
- Bench contacts: silent, pending §9 Q5.

## 6. UI & workflows (grounded in the actual app)

### 6.1 Change suggestions → home "Up Next" list

**Where:** `UnifiedActionList` (`src/components/home/unified-action-list.tsx`) — the home page's
discriminated-union action feed (action_item / reach_out / suggestion / recently_added), each row =
avatar + name + "why" line + colored badge + hover actions (Complete / Snooze 1d–1w / Save / Dismiss).

**Workflow (real life):** overnight, the cadence engine detects "Sarah Chen: promoted to Director of
Product at Domo." Next morning Dawson opens CareerVine home → Up Next shows a row with a
`PROFILE CHANGE` badge: *"Sarah Chen — Promoted to Director of Product at Domo (was Sr. PM)"* with
a pre-drafted congrats line. He clicks **Save** (becomes an action item), **Complete** (logs he
reached out), **Snooze**, or **Dismiss** (marks the change event dismissed; snooze reuses
`snoozeContact` → `reach_out_snoozed_until` + 3-week `suggestion_cooldown_until`).

**Integration reality (audit):** today's AI suggestions are **ephemeral** (generated per page-load
via `useSuggestions()` → `/api/suggestions/generate`, never persisted) and the generator hard-filters
`network_status = 'active'`. Change suggestions are the opposite: **persisted `contact_change_events`
rows** (status new/actioned/dismissed) merged into `unifiedItems` as a new item type — they don't
pass through the AI generator, so its active-only filter doesn't block prospect events; but
**surfacing prospects in the home feed is a product decision** (Q2/Q5, §9) since that feed has been
active-network-only so far. Fallback placement if Dawson says no: company-page-only (§6.6).

### 6.2 Per-contact "Refresh from LinkedIn" / "Find email"

**Where:** `ContactProfileCard` footer action row (`contact-profile-card.tsx:282` — currently
Edit/Delete) gains a **Refresh** action; the outreach flow's `PersonModal` (`person-modal.tsx:200`)
and the person cards' `no email` state (`outreach/page.tsx:371`) gain **Find email**.

**Workflow:** Dawson opens a contact → clicks Refresh → `POST /api/contacts/[id]/scrape`
(profile-only, or email mode when the contact has no non-bounced email) → route checks the 7-day
debounce + spend cap, starts the actor run, records a `scrape_runs` row → **toast** ("Refreshing
from LinkedIn…") and the button enters a pending state. The run completes asynchronously (§7):
webhook ingests → diff → merge → contact page revalidates; photo/employment/email update in place
and a toast confirms ("Found j.chen@domo.com ✓"). Contact page also gains the same *"Data as of …"*
staleness label company pages already render (`companies/[id]/page.tsx:501`).

### 6.3 Resolve-LinkedIn picker (no-URL manual contacts)

**Where:** `ContactProfileCard` shows **"Link LinkedIn profile"** where the LinkedIn link would
render (`:229`) when `linkedin_url` is null.

**Workflow:** click → modal (reuse `ui/modal.tsx`, pattern of `PersonModal`) → server calls actor B
with the contact's name + `strictSearch` + current company (company LinkedIn URL if we have it,
else location) → **exactly one match:** show the match card (photo, headline, company) with
Confirm/Not them; **multiple:** picker list; **zero:** manual URL paste field. Confirm stores the
canonical URL → contact enters the normal §6.2 lifecycle (offer immediate enrich).

### 6.4 Work anniversaries

**Where:** same Up Next feed, Tier-2 badge (*"3 years at Qualtrics this week"*).

**Audit reality check:** `start_month` is free text — actor-derived values can be bare years, and
extension AI-parse rows are unvalidated — so the generator parses defensively and **skips
month-less rows**. There's no existing computed-reminder engine to plug into (the feed is DB-backed
action items + ephemeral AI suggestions), so anniversaries are computed in the daily cron and
emitted as `contact_change_events` (type `anniversary`) with year-over-year dedupe — same rails as
every other suggestion in this plan. Still the cheapest phase (no Apify), no longer "free."

### 6.5 Extension enrich-on-save

**Where:** the extension side panel already has the needed chrome: staged progress bar
(`App.tsx:1262-1287`), status/error strips (`:1772`), an **auto-scrape toggle** persisted to
`chrome.storage.local` (`:1355-1370`), and a **"Refresh from LinkedIn"** button on the
already-in-CareerVine state (`:1326`).

**Workflow:** Dawson saves a profile → import completes as today → response includes
`enrichQueued: true` (when the §9 Q1 auto-enrich setting is on) → panel status reads "Saved ✓ —
enriching profile & searching email…" → on completion the panel (if still open) or the next app
visit shows the enriched result. The existing Refresh button wires to the same `/api/contacts/[id]/scrape`
endpoint as §6.2.

**Audit landmines this phase must fix (not optional):**
- **M2 — duplicate employment:** extension rows are inserted with default `source='manual'`; the
  merge preserves manual rows and inserts near-identical scraped rows alongside → duplicated
  current roles on exactly the contacts being enriched. Rule: an incoming scraped row sharing
  `company_id` + `is_current` with a manual row **supersedes** it (upgrade in place) instead of
  inserting a sibling.
- **m6 — extension re-save wipes scraped data:** `updateExistingContact` still delete-and-reinserts
  `contact_companies` as `source='manual'`, destroying scraped provenance and making the junk rows
  sacrosanct to future merges. Route extension re-saves through the merge engine.

### 6.6 Company page & scrape status

- **Company page** (`companies/[id]/page.tsx`): `PeopleSection` rows already show
  `staleness(last_scraped_at)`; change events for that company's contacts can badge rows
  (*"promoted 2w ago"*). The bench section's existing **"Add to outreach"** button
  (`promoteContactToProspect`, `:366`) is the exact pattern for the Q5 "promote to prospect?" hint.
- **Settings → new "Data & Scraping" tab** (tabs array at `settings/page.tsx:22-27`, card layout
  copied from `IntegrationsSection`): month-to-date spend (sum of `scrape_runs.cost_usd`), cadence
  status (last cron run, queue depth), the auto-enrich toggle (`ui/toggle.tsx`), and the kill-switch.

## 7. Technical architecture (Rev 3 — audit fixes integrated)

### 7.1 Rescrape mode (fixes audit blocker B1)

Rev 2's "wrap actor items as synthetic people-records and everything comes free" is **wrong as
written** — verified consequences: bench contacts get promoted to prospect (mapper defaults missing
selection → `'prospect'`; `resolveNetworkStatus` follows the incoming value for bench), everyone
gets stamped `network_scope='target_company'`, and `computeContactPatch` unconditionally overwrites
`import_source`/`import_meta`/`review_note` — wiping pipeline provenance (priority_rank,
adjacency_score, review verdicts) on all 2,000 contacts within one cadence cycle.

**Fix:** a `mode: 'rescrape'` variant of the contact patch that **never writes**
`network_status`, `network_scope`, `import_source`, `import_meta`, `review_note`, or `persona` —
a re-scrape refreshes observed profile data (headline, photo, employment, education, location,
email, `last_scraped_at`) and touches nothing pipeline- or user-owned. The wrapper must also
handle private/404 actor items (null `firstName`/`lastName` fails mapper validation) as an explicit
failure path feeding §7.5, and set `crm.email_source='verified'` (§4).

### 7.2 Async run lifecycle (fixes audit blocker B2)

Actor runs take minutes; every heavy route here is capped at `maxDuration=60`, and a timed-out
QStash delivery **retries — which would start a second paid run**. Split trigger from ingest:

- **`scrape_runs` table** — (id, user_id, apify_run_id, trigger source, contact ids, mode,
  status: pending/succeeded/failed/timed_out, cost_usd, created_at, finished_at). The ledger for
  idempotency, spend accounting, and the settings UI.
- **Trigger** (cron batch or per-contact button): check kill-switch + monthly cap
  (`sum(cost_usd) < cap`) → insert `scrape_runs` row → start actor run with `maxTotalChargeUsd`
  and an **Apify webhook** on run termination (`ACTOR.RUN.SUCCEEDED` etc.) pointing at
  `/api/apify/run-callback?token=<secret>`. Idempotency: a QStash retry finds the pending
  `scrape_runs` row for this batch and does **not** start a second run.
- **Ingest** (`/api/apify/run-callback`, secret-verified): load run + dataset items from Apify,
  wrap → map → **diff (§5)** → merge in rescrape mode → write `contact_change_events` + snapshots →
  mark the run row with actual cost (from Apify run usage). Batches sized so ingest fits 60s
  (≤50, matching bulk-import chunking).
- **Backstop:** a daily sweep marks `scrape_runs` stuck pending >24h as timed_out (webhooks can be
  missed) and re-queues their contacts.

### 7.3 Scheduler (fixes audit blocker B3)

`/api/cron/scrape-refresh` on a **daily** QStash schedule (schedule lives in the Upstash console,
like send-follow-ups — document it in the repo README): select ~75–90 eligible contacts —
`last_scraped_at IS NULL` first, then oldest; hot tier (§3) first; **exclude** contacts whose
canonical `linkedin_url` is in `suppressed_imports` (otherwise the drip re-selects the same
suppressed contact forever — `importPeopleChunk` skips them without advancing `last_scraped_at`);
exclude `scrape_failed_at` back-offs; group **per `user_id`** and import each group under that user
(cron uses the service client like send-follow-ups, so every `user_id` filter is load-bearing;
spend cap + kill-switch are global since it's one Apify token).

### 7.4 Data changes (migration files only, per house rules)

- **`contact_scrape_snapshots`** — (contact_id, scraped_at, normalized-subset jsonb incl. `hiring`,
  `openToWork`). Baseline for boolean flips + audit trail. (Pending §9 Q4.)
- **`contact_change_events`** — (contact_id, detected_at, type, old/new jsonb, tier, status
  new/actioned/dismissed, dedupe key). Feeds §6.1/6.4/6.6.
- **`scrape_runs`** — §7.2 ledger.
- **Failure tracking** — `scrape_failed_at` + consecutive-failure count on `contacts`.
- Employment supersede + location provenance changes as needed by §5/§6.5.

### 7.5 Failure handling

404/private → mark failure, exponential backoff; after N consecutive failures, actor-B re-resolve
(name + company, ~$0.008) to repair the URL; if that fails, surface "profile moved?" on the contact.

### 7.6 Known adjacent bug (pre-existing, not this increment)

`deleteContact` writes **no** `suppressed_imports` tombstone (nothing in the repo writes that table)
— deleted pipeline contacts resurrect on the next tranche import. Flagged separately; this plan only
*reads* suppressions (§7.3).

### 7.7 Testing commitments

Pure-module Vitest coverage mirroring scrape-merge: `computeDiff` (pairing, false-positive guard,
boolean baselines, dedupe), rescrape-mode patch semantics (the B1 fields never move), email
bounce/verified rules, wrapper validation failures; route-level tests for callback idempotency and
QStash-retry-no-double-run. Suite must pass before every push (rules 3/4).

## 8. Build order

0. **Anniversaries** — change-events table + generator + Up Next integration. No Apify. Proves the
   suggestion rails end-to-end.
1. **Per-contact path** — Apify client, `scrape_runs` + webhook callback, rescrape-mode merge
   (§7.1), `/api/contacts/[id]/scrape`, ContactProfileCard Refresh + staleness label, extension
   enrich-on-save **including the M2/m6 employment fixes**, find-email in outreach/PersonModal.
2. **Cadence engine** — snapshots, daily drip cron (§7.3), diff engine (§5), change events at scale.
3. **Surfacing + resolvers** — Up Next change suggestions, email-on-company-change, actor-B no-URL
   picker + URL-rot repair, Settings "Data & Scraping" tab.

## 9. Open questions for Dawson (blocking implementation)

1. Auto-enrich on extension save (recommended) vs explicit button only?
2. Change suggestions on the home Up Next feed even for `prospect` contacts (feed has been
   active-only so far), or company-page-only for prospects?
3. Comfortable with ~$10/mo steady-state Apify spend (hard monthly cap enforced in `scrape_runs`)?
4. Snapshot table (recommended — required for `hiring`/`openToWork` signals) vs diff-against-live-rows only?
5. Bench carve-out: may a bench contact moving *into* a target company surface a company-page
   "promote to prospect?" hint (the existing bench "Add to outreach" button pattern), or stay fully silent?
