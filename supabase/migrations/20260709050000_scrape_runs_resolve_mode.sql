-- Plan 29 (CAR-15) phase 3: 'resolve' scrape mode.
--
-- Actor-B (search-by-name) lookups resolve a LinkedIn profile for contacts
-- with no URL, or repair a renamed URL. They're synchronous short-mode
-- searches ($0.004/page) but still spend Apify budget, so they land in the
-- scrape_runs ledger under mode='resolve' to keep the monthly cap honest.

ALTER TABLE scrape_runs DROP CONSTRAINT IF EXISTS scrape_runs_mode_check;
ALTER TABLE scrape_runs ADD CONSTRAINT scrape_runs_mode_check
  CHECK (mode IN ('profile', 'email', 'resolve'));
