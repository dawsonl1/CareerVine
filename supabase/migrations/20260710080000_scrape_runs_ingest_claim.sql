-- Deep-review 3, finding D: webhook ingest had no atomic claim, so a duplicate
-- Apify delivery racing a slow first ingest could double-apply the merge —
-- inserting permanent duplicate employment rows (no unique index catches them:
-- the legacy contact_companies index keys on start_date, which imports never
-- write). ingestScrapeRun now claims the run via a counted CAS on this column
-- before touching data; a stale claim (crashed ingest) is re-claimable after
-- 10 minutes, and the row stays 'pending' so the 24h sweep still applies.
ALTER TABLE scrape_runs ADD COLUMN ingest_claimed_at timestamptz;

COMMENT ON COLUMN scrape_runs.ingest_claimed_at IS 'Set by the webhook ingest''s atomic claim (CAS, count-checked). NULL or >10min old = claimable. Prevents concurrent duplicate deliveries from double-merging a run.';
