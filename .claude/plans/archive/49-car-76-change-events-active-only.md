# CAR-76: Change events active-only — stop bundle prospects surfacing as Up Next tasks

## Problem

Subscribing to a data bundle floods Up Next with "work anniversary" tasks for prospects the
user never added to their network. Verified in production: 92 `contact_change_events` rows,
all tier-2 anniversaries, all on `network_status='prospect'` bundle-imported contacts.

Every other Up Next feeder (AI suggestions, reach-out, recently-added, first-touch) already
hard-filters `network_status='active'`. The plan-29 change-events pipeline is the one
exception — its producer and reader deliberately included `prospect` (plan-29 §9 decision 2),
a call made in the scrape-diff context ("prospect at target company just got promoted")
before 6,000-contact bundles existed. Dawson decided 2026-07-11: **active only**.

## Changes

1. **Anniversary producer** — `syncAnniversaryEvents` in
   `careervine/src/lib/change-events/change-events.ts`: scan
   `network_status = 'active'` only (was `in ["active", "prospect"]`).

2. **Up Next reader** — `fetchChangeEventSuggestions` in the same file: surface events only
   when the joined contact is `active` (was `in ["active", "prospect"]`). This is the choke
   point: scrape-diff events on prospects keep being *recorded* (they still power company-page
   badges) but never reach the home feed. Update the plan-24 containment comment.

3. **Scrape cadence bundle carve-out** — `pickCadenceCandidates` in
   `careervine/src/lib/apify/cadence.ts`: exclude `import_source LIKE 'bundle:%'` contacts
   (NULL-safe: `import_source.is.null` OR `not.like`). Bundle contacts refresh centrally via
   bundle re-publish; without this, ~6,000 bundle contacts enter the per-user $10/mo Apify
   rotation once their imported `last_scraped_at` ages past `CADENCE_MIN_AGE_DAYS` (14d,
   ~2026-07-21).

## Explicitly unchanged

- **Company-page badges** (`getFreshJobChangeContactIds` in `queries.ts`) keep covering
  prospect/bench job changes — that surface is the point of prospect diff events.
- **Scrape-diff producer** (`processDiffs` in `scrape-service.ts`) keeps writing events for
  whatever was scraped — reader gates surfacing.
- Non-bundle prospects (own pipeline imports) stay in the scrape cadence per plan-29
  decision 1.

## Tests

- Extend change-events / cadence coverage for the new filters where the existing mock
  patterns allow; run `npm run test` from `careervine/`.

## Ops (after merge + deploy)

- Delete the 92 stale `status='new'` anniversary events on non-active contacts (invisible
  after the reader fix; cleanup only).

## No migrations, no env changes.
