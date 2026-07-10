-- Plan 29 (CAR-15) phase 1b: distinct provenance for extension AI-parsed
-- employment rows.
--
-- The deep review found that extension-imported employment rows land as
-- source='manual' (the column default), making them indistinguishable from
-- rows the user hand-typed. That forced the rescrape merge into a conservative
-- "skip" on current-role collisions — it could not safely supersede an
-- AI-parsed row without risking a user's real edit.
--
-- 'extension' marks AI-parsed rows from the Chrome-extension import. The merge
-- engine may supersede them with fresh scrape data (scrape > AI parse in
-- fidelity); only 'manual' rows keep the never-overwrite guarantee.

ALTER TABLE contact_companies DROP CONSTRAINT IF EXISTS contact_companies_source_check;
ALTER TABLE contact_companies ADD CONSTRAINT contact_companies_source_check
  CHECK (source IN ('scraped', 'manual', 'extension'));

COMMENT ON COLUMN contact_companies.source IS 'Row provenance for the merge engine: scraped = actor data (auto-updatable/removable), extension = AI-parsed from the Chrome extension (supersedable by scrapes), manual = user-entered (never auto-modified)';
