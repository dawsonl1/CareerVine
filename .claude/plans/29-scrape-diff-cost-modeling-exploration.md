# 29 — Scrape-Diff & Find-Email (CAR-15)

**Status:** Rev 2, 2026-07-09 — exploration complete, actor decisions settled; awaiting Dawson's
answers to the open questions (§8) before implementation.
**Linear:** [CAR-15](https://linear.app/career-vine/issue/CAR-15/explore-benefits-of-a-weekly-or-bi-weekly-or-monthly-appify-contact) (In Progress).
Spun out: [CAR-29](https://linear.app/career-vine/issue/CAR-29/discovery-feed-surface-new-pm-hires-at-target-companies)
(new-PM-hires discovery feed) — **out of scope for this increment**.
Pricing verified against live Apify actor listings at BRONZE tier (Dawson's Starter account), 2026-07-08.

## 1. Scope of this increment

**In scope:**

1. **Enrich never-scraped contacts** — extension saves (no photo/email, AI-parsed employment) and
   manual adds (may lack even a `linkedin_url`).
2. **Cadence re-scrape + diff** of known contacts → outreach-worthy change suggestions.
3. **Find-email** — event-driven (on company change) + on-demand per contact.
4. **Free win:** work-anniversary touchpoints derived from stored `start_month` — no scraping,
   can ship first and independently.

**Out of scope:**

- Discovering *new* people (search-based prospecting) → CAR-29.
- Monitoring companies via the employees actor (see §2, rejected).
- Third-party email vendors (one optional exception noted in §4).

## 2. Actor decisions (settled)

Three HarvestAPI actors were compared. All return the identical full-profile payload our mapper
consumes (`raw_profiles[].data` in people-records is this actor item verbatim) and share the same
per-profile events ($0.004 full / $0.01 full+email at BRONZE, no start fees). They differ only in
**how you address a person**:

| | A. `linkedin-profile-scraper` | B. `linkedin-profile-search-by-name` | C. `linkedin-profile-search` |
| --- | --- | --- | --- |
| **Addressing** | Exact: profile URLs / public identifiers / profile IDs | Name (first+last, `strictSearch`) + filters (location, current/past company, school, industry) | Filters/fuzzy query only — cannot target a specific person |
| **Search-page fee** | none | **$0.004** / page (≤10 short profiles) | **$0.10** / page (≤25 short profiles) |
| **Full profile** | $0.004 | $0.004 (also "main profile" mode $0.002) | $0.004 |
| **Full + email** | $0.01 | $0.01 | $0.01 |
| **Typical unit** | $0.004/contact | ~$0.008/lookup; $0.014 with email | ≥$0.10/query + $0.004/profile |

**Decisions:**

- **A is the engine.** Every scrape in this increment goes through A — we store `linkedin_url`
  and `public_identifier` on scraped contacts, so addressing is exact with zero search overhead.
- **B is the fallback resolver, two jobs only:**
  1. *No-URL contacts* (manual adds): resolve name → profile with `strictSearch: true` +
     `currentCompanies` (we store company LinkedIn URLs) or `locations` as disambiguators
     (~$0.008–0.014). Auto-accept only single-result matches; multi-match → user picks in UI.
  2. *URL-rot repair*: when A 404s repeatedly (person renamed their public identifier),
     re-resolve by name + current/past company filter and update the stored URL.
- **C is not used in this increment.** It's a discovery tool (it powers the external pipeline's
  Search A/B). Its `recentlyChangedJobs`/`recentlyPostedOnLinkedIn` filters are the basis of the
  CAR-29 discovery feed. For monitoring *known* contacts it loses outright: $0.10/page firehose
  results that can't be scoped to our 2,000 people, vs $8 to precisely re-scrape the entire fleet.

**Rejected:**

- **`harvestapi/linkedin-company-employees`** ($0.008/full + $0.02 start per company): 2× the
  per-profile price, and it enumerates *current* employees — structurally missing the
  highest-value event, people who left.
- **Cheap email-only actors** (`snipercoder` $0.8/1k, `x_guru` $2/1k, `vulnv` $0.028/found):
  unverified quality, second vendor, second payload shape. HarvestAPI emails are SMTP-verified
  and match the pipeline's `emails[] = verified` contract. One optional exception in §4.

## 3. Cost model & cadence recommendation

### Fleet context (measured 2026-07-08 against the pipeline's people/ records)

- 2,000 pipeline people-records (1,566 `target_company`, 325 `broad_network`); ~240 in prod so
  far (loader re-run pending).
- **78% (1,561/2,000) already have verified emails** from the original full+email scrape.
  The 439 without are profiles where email search **already failed once**.
- 1,635/2,000 have photos in raw payloads.
- Extension-saved `active` contacts: small count, never scraped.

### Cadence scenarios (fleet = 2,000, profile-only mode via actor A)

| Cadence | Monthly cost |
| --- | --- |
| Weekly, whole fleet | ~$34.70 |
| Biweekly, whole fleet | ~$17.30 |
| **Monthly, whole fleet** | **$8.00** |
| Tiered: ~300 hot biweekly + rest monthly | ~$9.40 |
| Tiered: ~300 hot biweekly + bench quarterly | ~$4.90 |

**Recommendation: monthly fleet-wide + biweekly hot subset.** Hot = prospects at target companies
with `next_app_date` within ~60 days, or derived stage ≥ contacted. Job-change base rate is
~1–2%/mo, so monthly catches changes with ~2-week average lag — comfortably inside the congrats
window. Weekly is 4× cost for marginal recency. Also event-triggered: refresh a company's contacts
when its app window approaches. **Expected steady state ~$9–11/mo**, inside the Starter plan's
$39/mo prepaid credit alongside pipeline runs.

### Per-contact button math

No start fee ⇒ a single-profile run costs the same per profile as a batch. Per-contact vs bulk
is a non-question: design the button for UX (7-day `last_scraped_at` debounce), not price.
A click is a penny. Never run cadence re-scrapes in email mode (2.5× for near-zero yield, §4).

## 4. Email strategy

Email search is charged **per attempt**, found or not (SMTP-verified results → `emails[]`).
The 439 email-less contacts already failed a search once — blind bulk retry ≈ $4.39 of mostly
repeat failures. Instead:

1. **Never-scraped contacts:** first scrape in **email mode** ($0.01) — one run fills photo +
   real employment history + headline + verified email. Best $/value in the feature.
2. **Previously-failed contacts:** re-attempt **only on detected company change** — new employer
   = new domain = genuinely fresh chance. Event-driven, not cadence-driven.
3. Optional cost floor: run the retry set through `vulnv/linkedin-email-finder` pay-per-found
   ($0.028/found, $0 on miss) — beats pay-per-attempt when hit rate < ~36%, which is exactly the
   retry-after-failure situation. Second vendor, so only if harvestapi retry yield proves poor.

Merge safety already exists: `contact_emails.source` monotonic upgrade + `bounced_at` handling
in `scrape-merge.ts` — a found email lands as `scraped`/`verified`, never clobbers manual entries.

## 5. Diff taxonomy (what changes are outreach-worthy)

Diff keys must be the **normalized natural keys scrape-merge already uses** —
`(linkedin_company_id, title, start_month)` for employment — never raw strings, or company
renames ("Domo" vs "Domo, Inc.") produce false diffs.

**Tier 1 — act now (→ outreach suggestions):**
- **Company change** — new `is_current` employment row at a different `linkedin_company_id`.
  The money event: natural congrats note; warm door if the new company is a target company;
  also the trigger for email re-search (§4).
- **Promotion / title change at same company** — congrats note.
- **`hiring` flag flips true** (raw payload field) — they're publicly hiring; direct opportunity.
- **`openToWork` flips true** — they're hunting; peer-networking playbook, different tone.

**Tier 2 — good touchpoints:**
- New certification / completed degree.
- Location change (especially into Dawson's metro).
- **Work anniversary — needs NO scrape** (derivable from stored `start_month`). Ship first.

**Tier 3 — silent data refresh, never a suggestion:**
- Photo added/changed (fixes the no-picture contacts), headline/about rewording, skills,
  follower/connection counts.

**Noise rules:** suppress diffs where the old value was null (first enrichment ≠ change);
respect `suggestion_cooldown_until`; bench contacts stay out of all suggestion surfaces
(plan-24 containment) — pending carve-out question in §8.

## 6. Architecture (maximal reuse of existing machinery)

- **Apify client:** first in-repo Apify integration — a small server-side helper calling actor A
  (and B for resolver flows) with `maxTotalChargeUsd` set on **every** run (house rule), plus a
  monthly spend cap and kill-switch env var.
- **Reuse the import brain:** wrap each actor item as a synthetic schema-v1 people-record
  (`raw_profiles: [{source: 'rescrape', data: item}]`) and feed `importPeopleChunk` → mapper,
  never-demote status logic, monotonic email merge, SSRF-guarded photo download, and
  `last_scraped_at` refresh all come free.
- **Diff step:** compare the mapped result against current normalized rows (`contacts` core
  fields, `contact_companies`, `contact_emails`) *before* merge; emit change events.
- **Scheduler:** clone the QStash pattern (`/api/cron/send-follow-ups`, signature-verified).
  A `/api/cron/scrape-refresh` route drip-processes the ~25 stalest eligible contacts per day
  (oldest `last_scraped_at`, hot tier first) — stays under the 60s `maxDuration`, smooths spend,
  covers the fleet monthly. No Vercel crons needed.
- **Surfacing:** Tier-1/2 diffs for `active`/`prospect` → outreach suggestion feed with a
  pre-drafted congrats/context line. Tier-3 → silent update. Bench → silent (pending §8 Q5).
- **Extension flow:** on save, auto-trigger a single-profile email-mode scrape via A (pending
  §8 Q1 — auto recommended). Fixes photo + employment quality vs the AI-parse path too.
- **No-URL resolver:** for manual contacts missing `linkedin_url`, a B-powered resolve flow —
  auto-accept single-match, otherwise a pick-the-right-person UI; store the resolved URL, then
  the contact enters the normal A lifecycle.
- **Failure handling:** 404/private → record failure state, exponential backoff; after N
  consecutive failures attempt a B re-resolve (name + company filter, ~$0.008) to repair the
  stored URL before surfacing "profile moved?".

### Proposed data changes (migration files only, per house rules)

- **`contact_scrape_snapshots`** — (contact_id, scraped_at, normalized-subset jsonb). Makes diffs
  auditable and gives `hiring`/`openToWork` (not persisted anywhere today) a baseline.
  ~2k rows/month — negligible. (Pending §8 Q4.)
- **`contact_change_events`** — (contact_id, detected_at, type, old/new jsonb, status:
  new/actioned/dismissed). Feeds the suggestion surface; keeps diff results replayable.
- **Failure tracking** — `scrape_failed_at` + consecutive-failure count (on `contacts` or in
  the snapshots table).

## 7. Proposed build order

0. **Anniversaries quick win** — Tier-2 touchpoint from existing `start_month` data. No Apify,
   no migration beyond (maybe) change-events. Independent value on day one.
1. **Apify client + per-contact path** — A-powered enrich-on-save (extension) and find-email
   action, synthetic people-record → `importPeopleChunk` reuse. This alone delivers the
   photo/email itch that motivated CAR-15.
2. **Cadence engine** — snapshots + `/api/cron/scrape-refresh` QStash drip + diff engine +
   change events.
3. **Surfacing + event-driven email** — suggestion feed integration, email re-search on company
   change, B resolver flows (no-URL + URL-rot repair).

Each phase lands with Vitest coverage and follows the commit/push + migration conventions
(rules 3, 4, 10, 11, 14).

## 8. Open questions for Dawson (blocking implementation)

1. Auto-enrich on extension save (recommended) vs explicit button?
2. Where do change suggestions live — existing follow-up feed, company page, or both?
3. Comfortable with ~$10/mo steady-state Apify spend for this?
4. Snapshot table (recommended) vs diff-against-live-rows only?
5. Bench carve-out: may a bench contact moving *into* a target company surface a
   "promote to prospect?" hint (data-adjacent, not outreach), or stay fully silent?
