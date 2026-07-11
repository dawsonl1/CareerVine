-- CAR-63: bundle company memberships accumulate across republishes.
-- publishCompaniesChunk only ever added membership rows, so companies that
-- dropped out of (or were renamed in) the source list kept their links from
-- earlier publishes (apm-data-bundle: 104 memberships vs 99 source companies).
--
-- Mirror the bundle_prospects seen-tracking: chunks stamp the staging version
-- on every membership they touch, and finalizePublish hard-deletes rows not
-- seen in the current run. NULL is intentionally left unbackfilled — it means
-- "not seen since this feature landed", so the first post-deploy republish
-- prunes the stale rows without any ad-hoc SQL.
ALTER TABLE bundle_companies ADD COLUMN IF NOT EXISTS version_last_seen int;

COMMENT ON COLUMN bundle_companies.version_last_seen IS
  'Staging version of the last publish run that included this company; rows not stamped by the current run are deleted at finalize (CAR-63).';
