# 32 - IB Recruiting Pipeline

## Product goal

Seed a CareerVine **data-subscription bundle** for investment-banking recruiting:
BYU-family alumni plus the working population of each bank's offices, so a new
user targeting IB starts with a ready-to-work set of contacts instead of an empty
CRM. This is the "every IB analyst at the NYC boutiques, plus the banks and their
offices" bundle described in the README.

Scope of *this* work item: **produce and review the data only.** Ingestion into
CareerVine (mapping to `data_bundles` / scrape-import schema) is a later work item.

## Data

30 banks / 228 US IB offices, from `research/ib-banks-and-offices.xlsx`
(LinkedIn company URLs resolved and committed to that sheet). Snapshotted into
`pipelines/ib-pipeline/data/{banks,offices}.json`.

## What we collect

- **Alumni** at each bank in an IB role at **any** level (analyst -> MD).
- **Per office**: 6 analysts, 3 associates, 1 VP, 1 director -- filled with
  *confirmed* non-alumni. Alumni are additive (kept on top, never consume a slot).

## Design decisions

1. **Two search shapes.** Alumni = profile-search scoped by `schools` + bank URL,
   no location (office assigned in review from profile location). Office population
   = company-employees scoped by bank URL + per-office `locations` (the only way to
   scope a headcount to one office, since all of a bank's offices share one company
   page).
2. **No relevance judgment in code.** Every profile passes an agent review gate.
3. **Confirm-to-target loop.** Office bands backfill deeper until they hit their
   *confirmed* non-alum target or the office goes dry (a true "only N exist").
4. **Email deferred.** All scraping in `Full` mode, no email; one enrichment pass
   over confirmed keepers only -- no email spend wasted on discards.
5. **Universal banks -> parent company page** (BofA, Citi, Wells Fargo, etc.),
   where IB bankers self-tag; the `Investment Banking` title + metro isolates them.
6. **Resume-safe** run markers so the 5-hour usage limit can't waste spend.

## Stages

1. `alumni-breadth` (scrape) -> review -> keep currently-in-IB alumni
2. `office-pull` (scrape) -> review -> confirm band + office, flag alumni
3. `office-backfill` loop -> every office/band at target-or-dry
4. `email-enrich` over all confirmed keepers

Expected spend ~$50-60; per-run `maxTotalChargeUsd` caps bound worst case ~$85.

## Status

- [x] Data snapshot + resolved LinkedIn URLs (committed to the reference sheet)
- [x] Scaffold: configs, orchestrator (`run_ib.py`), engine copy, gitignore, README
- [ ] Resolve-check the 30 bank URLs (confirm each returns IB-titled employees)
- [ ] Verify the email-enrich actor input schema (`ib_alumni_email.json`)
- [ ] Launch alumni-breadth -> review -> office-pull -> backfill -> email-enrich
- [ ] Later work item: ingest the reviewed bundle into CareerVine
