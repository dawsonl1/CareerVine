# 29 — Scrape-Diff & Find-Email Exploration (CAR-15)

**Status:** Exploration / design — no implementation yet.
**Linear:** [CAR-15](https://linear.app/career-vine/issue/CAR-15/explore-benefits-of-a-weekly-or-bi-weekly-or-monthly-appify-contact)
**Date:** 2026-07-08. Pricing verified against Apify live actor listings at BRONZE tier (Dawson's Starter account).

CAR-15 bundles three ideas:

1. **Enrich never-scraped contacts** (extension saves have no photo, no email, AI-parsed employment).
2. **Cadence re-scrape + diff** of already-imported contacts to catch profile changes → prompt organic outreach.
3. **Find-email** — per-contact button and/or bulk for contacts missing an email.

## 1. Unit economics (verified 2026-07-08, BRONZE tier)

The right actor for everything here is **`harvestapi/linkedin-profile-scraper`** — it takes
profile URLs / public identifiers directly (both stored on `contacts`), has **no
per-run start fee**, and returns the same payload shape our mapper already consumes
(`raw_profiles[].data` in people-records is this actor's item verbatim).

| Event | Price |
| --- | --- |
| Profile details | **$0.004** / profile |
| Profile details + email search | **$0.01** / profile (charged per attempt, found or not; SMTP-verified results → `emails[]`) |
| Per-run start fee | none |

Why not the alternatives:

- **`harvestapi/linkedin-company-employees`** ($0.008/full profile + $0.02 start per company): 2× the
  per-profile price, and it enumerates *current* employees of a company — so it structurally
  **misses the highest-value event, people who left**. Wrong tool for refreshing known contacts.
- **Cheap email-only actors** (`snipercoder/bulk-linkedin-email-finder` $0.8/1k,
  `x_guru` $2/1k, `vulnv/linkedin-email-finder` $0.028 *per email found*): cheaper on paper, but
  unverified quality, and they'd introduce a second vendor + a second payload shape. HarvestAPI
  emails are SMTP-verified and match the pipeline's existing `emails[] = verified` contract.
  Only interesting case: `vulnv` pay-per-found beats harvestapi pay-per-attempt when expected
  hit rate < ~36% — which is exactly the situation for retrying past failures (see §3). Optional.

### Fleet-size context

- 2,000 pipeline people-records exist (1,566 `target_company`, 325 `broad_network`); ~240 are in prod so far (loader re-run pending).
- **78% (1,561/2,000) already have verified emails** from the original full+email scrape. The 439 without are profiles where email search **already failed once**.
- 1,635/2,000 have photos in the raw payloads.
- Extension-saved `active` contacts: small count, never scraped — no photo pipeline data, no email, no `last_scraped_at`.

### Cadence cost scenarios (fleet = 2,000, profile-only mode)

| Cadence | Monthly cost |
| --- | --- |
| Weekly, whole fleet | ~$34.70 |
| Biweekly, whole fleet | ~$17.30 |
| **Monthly, whole fleet** | **$8.00** |
| Tiered: ~300 hot biweekly + rest monthly | ~$9.40 |
| Tiered: ~300 hot biweekly + bench quarterly | ~$4.90 |

All of these fit inside the Starter plan's $39/mo prepaid credit alongside pipeline runs
(tranche-1 was ~$26 one-time). Adding email search fleet-wide multiplies by 2.5× for near-zero
yield (see §3) — never do cadence re-scrapes in email mode.

### Per-contact button math

No start fee ⇒ **a single-profile run costs the same per profile as a batch** ($0.004 / $0.01).
Dawson's "per-contact vs all contacts, whichever is cheaper" question dissolves: price is
identical per profile; batching only amortizes latency. Design the button for UX, not cost —
guard with a `last_scraped_at < 7 days` debounce instead of price friction. A click costs a penny.

## 2. What profile changes are outreach-worthy (diff taxonomy)

Signals ranked by outreach value. Diff keys must be the **normalized natural keys scrape-merge
already uses** — `(linkedin_company_id, title, start_month)` for employment — not raw strings,
or company-rename noise ("Domo" vs "Domo, Inc.") produces false diffs.

**Tier 1 — act now (feed into outreach suggestions):**
- **Company change** — new `is_current` employment row at a different `linkedin_company_id`. The money event: congrats note lands naturally, and if the new company is a target company it's a warm door. Also the moment their **email changes** — see §3.
- **Promotion / title change at same company** — same company id, new title + new start_month. Congrats note.
- **`hiring` flag flips true** (raw payload field) — they're publicly hiring; direct opportunity conversation.
- **`openToWork` flips true** — they're hunting; peer-networking playbook, different message tone.

**Tier 2 — good touchpoints:**
- New certification / completed degree.
- Location change (especially into Dawson's metro).
- **Work anniversary — needs NO scrape.** Derivable today from stored `contact_companies.start_month`. Zero-cost quick win; ship independently of everything else.

**Tier 3 — data refresh only, never a suggestion:**
- Photo added/changed (update avatar — this alone fixes the "contacts without profile pictures" itch), headline/about rewording, skills, follower/connection counts.

Noise rules: suppress a "diff" when the old value was null (first enrichment ≠ change); respect
`suggestion_cooldown_until`; **bench stays data-only** (plan-24 containment rule) — with one
carve-out worth discussing: a bench contact who moves *into* a target company could surface a
"consider promoting to prospect" hint on the company page rather than the outreach feed.

## 3. Email strategy — the key insight

Email search is charged **per attempt**, and the 439 email-less contacts already failed once.
Blind bulk re-search ≈ $4.39 for mostly repeat failures. Instead:

1. **Never-scraped contacts** (extension saves): first scrape in **email mode** ($0.01) — one run
   fills photo + employment + headline + verified email. Best $/value in the whole feature.
2. **Previously-failed contacts:** re-attempt **only on detected company change** — new employer =
   new domain = a genuinely fresh chance. Event-driven, not cadence-driven.
3. Optional cost floor: run the retry set through `vulnv` pay-per-found ($0.028/found, $0 on miss)
   since expected hit rate on past failures is well under the 36% break-even. Second vendor, so
   only if the harvestapi retry yield proves poor.

Merge safety already exists: `contact_emails.source` monotonic upgrade + `bounced_at` handling in
`scrape-merge.ts` — a found email lands as `scraped`/`verified` and never clobbers manual entries.

## 4. Architecture sketch (maximal reuse)

Nothing here requires new pipelines — it's the first **in-repo** Apify call plus glue:

- **Apify client:** small server-side helper calling `harvestapi/linkedin-profile-scraper` with
  `maxTotalChargeUsd` set on every run (house rule). Input: `publicIdentifiers`/`urls` from `contacts`.
- **Reuse the whole import brain:** wrap each actor item as a synthetic schema-v1 people-record
  (`raw_profiles: [{source: 'rescrape', data: item}]`) and feed `importPeopleChunk` → mapper,
  never-demote status logic, monotonic email merge, SSRF-guarded photo download, `last_scraped_at`
  refresh all come free.
- **Diff step:** compare mapped result against current normalized rows (`contacts` core fields,
  `contact_companies`, `contact_emails`) *before* merge, emit change events. Recommended: add a
  small `contact_scrape_snapshots` table (contact_id, scraped_at, normalized-subset jsonb) so diffs
  are auditable and future signals (hiring/openToWork, which aren't persisted today) have a baseline.
  ~2k rows/month — negligible.
- **Scheduler:** clone the existing QStash pattern (`/api/cron/send-follow-ups`, 15-min
  signature-verified invocations). A `/api/cron/scrape-refresh` route drip-processes the ~25 stalest
  eligible contacts per day (oldest `last_scraped_at`, hot tier first) — stays under the 60s
  `maxDuration`, smooths spend, covers the fleet monthly. No Vercel crons needed.
- **Surfacing:** Tier-1/2 diffs for `active`/`prospect` → outreach suggestion feed with a
  pre-drafted congrats/context line. Tier-3 → silent data update. Bench → silent, except the
  promote-hint carve-out.
- **Extension flow:** on save, auto-trigger a single-profile email-mode scrape (a penny; auto >
  button for UX, with a settings toggle). Also fixes photo + employment quality vs the AI-parse path.
- **Failure handling:** 404/private/renamed profiles → record `scrape_failed_at`, exponential
  backoff, surface after N consecutive failures ("profile moved?").

## 5. Recommended cadence

**Monthly fleet-wide + biweekly hot subset, email mode only on events.**

- Job-change base rate is ~1–2%/mo of contacts; monthly cadence catches changes with ~2-week average
  lag — comfortably inside the socially-acceptable congrats window. Weekly is 4× the cost for
  marginal recency on a signal that stays fresh for a month.
- Hot subset = prospects at target companies with `next_app_date` within ~60 days, or derived stage
  ≥ contacted. Also: event-triggered refresh of a company's contacts when its app window approaches.
- Expected steady state: **~$9–11/mo**, inside existing Starter credit.

## 6. Open questions for Dawson

1. Auto-enrich on extension save (recommended) vs explicit button?
2. Where do change suggestions live — existing follow-up feed, company page, or both?
3. Comfortable with ~$10/mo steady-state Apify spend for this?
4. Snapshot table (recommended) vs diff-against-live-rows only?
5. Bench promote-hint carve-out: yes/no?

## Adjacent idea (out of scope, noting for later)

`harvestapi/linkedin-profile-search` has a `recentlyChangedJobs` filter — could power a separate
"new PMs just joined your target companies" discovery feed (finding *new* people, not refreshing
known contacts). Different feature; don't conflate with CAR-15.
