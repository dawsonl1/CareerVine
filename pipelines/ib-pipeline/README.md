# IB Recruiting Pipeline

Generates a curated, reviewed dataset of investment-banking contacts (BYU-family
alumni + per-office bankers across 30 banks / 228 US offices) to seed a CareerVine
**data-subscription bundle**. This folder only *produces and reviews the data*;
how it gets ingested into CareerVine is handled separately.

Lives under `pipelines/` so future prospect pipelines (other industries, schools,
or company sets) can sit alongside it.

## What it collects

Per the 30 banks and 228 offices in `data/` (sourced from
`research/ib-banks-and-offices.xlsx`):

1. **Alumni** — every BYU / BYU-Idaho / BYU Marriott alum currently in an
   investment-banking role at each bank, **at any level** (analyst -> MD).
2. **Office population** — per office: **6 analysts, 3 associates, 1 VP,
   1 director**, filled with *confirmed* non-alumni. Alumni are additive: an alum
   found in an office pull is kept as an alum and does **not** consume an office slot.

No relevance judgment is ever made in code. Every profile passes a
one-at-a-time agent review gate that decides KEEP/DISCARD and the person's role.

## Pipeline stages

| Stage | What | Spend |
|---|---|---|
| 2a `alumni-breadth` | 1 profile-search run/bank: schools + bank URL, **no title filter**, Full mode **no email** | ~$10 |
| 2b review | agents keep only currently-in-IB alumni (any level) | — |
| 3 `office-pull` | 1 company-employees run per (office x band): bank URL + office location + band titles, capped at target. Full mode **no email** | part of ~$40 |
| 4 review | agents confirm each is that IB band at that office; flag alumni | — |
| 5 `office-backfill` | re-pull offices/bands short of their *confirmed* target, grown window, dedup by URL, until target or **dry** | part of ~$40 |
| 2c `email-enrich` | ONE by-URL run over all confirmed keepers to fetch emails | ~$3 |

**Email is deferred everywhere**: all scraping runs pull in `Full` mode with no
email; a single enrichment pass at the end fetches email only for confirmed
keepers, so we never pay for email on anyone review discards.

Expected total **~$50-60**; a hard `maxTotalChargeUsd` cap on every run bounds
the worst case (~$85 aggregate).

## Layout

```
config/     6 actor configs (alumni breadth, alumni email, 4 office bands)
data/       banks.json, offices.json (resolved snapshot + LinkedIn URLs/locations)
pipeline/   run_ib.py (orchestrator), run_search.py (engine), review helpers
scrapes/    raw datasets + run markers          [gitignored -- PII]
reviews/    review batches + verdicts           [gitignored -- PII]
```

Scraped profiles are real people's PII (names, emails, work history) and are
**gitignored** -- only code, config, and reference data are committed.

## Running

```sh
# always dry-run first to inspect the exact actor input
python3 pipeline/run_ib.py alumni-breadth --dry-run
python3 pipeline/run_ib.py alumni-breadth [--only-bank goldman-sachs]

python3 pipeline/run_ib.py office-pull [--only-bank ... --only-band analyst]
# ... agent review of the pulls ...
python3 pipeline/run_ib.py office-backfill --shortfall reviews/<...>/shortfall.json

python3 pipeline/run_ib.py email-enrich --urls reviews/<...>/confirmed_urls.txt
```

Runs are resume-safe: each writes a `run_launched.json` marker before polling,
so an interrupted process reconnects to the in-flight Apify run instead of
launching a duplicate.

Requires `APIFY_API_TOKEN` in the environment.
