-- Plan 36 (CAR-25 scope): per-account Apify spend controls.
--
-- Two admin-owned kill switches on users, following the `status` pattern from
-- the admin foundation (20260709140000):
--   apify_enrichment_enabled — gates every path that SPENDS Apify money for
--     the account: extension auto-enrich on save, the daily cadence drip,
--     manual Refresh / Find Email, and the LinkedIn resolver. Off = no new
--     spend (in-flight runs still ingest; the money is already spent).
--   diff_analysis_enabled — gates change-event production from scrape
--     ingests (diff engine + anniversaries). Data still merges and snapshots
--     still record; the account just stops generating change events.
--
-- Default TRUE preserves current behavior; the admin dashboard turns things
-- off per account or in bulk.
ALTER TABLE users ADD COLUMN apify_enrichment_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN diff_analysis_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN users.apify_enrichment_enabled IS 'Admin kill switch for all paid Apify activity on this account (auto-enrich, cadence, manual scrape/find-email/resolve). Writable only by the service role.';
COMMENT ON COLUMN users.diff_analysis_enabled IS 'Admin kill switch for change-event production from scrape ingests. Merge + snapshots unaffected. Writable only by the service role.';

-- Self-escalation guard, same two layers as `status`:
-- 1. Column privileges: the authenticated GRANT lists profile columns only,
--    so these new columns are already un-updatable by users. (No change.)
-- 2. Belt-and-suspenders: pin them in the self-update policy's WITH CHECK.
DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND status = (SELECT u.status FROM users u WHERE u.id = auth.uid())
    AND apify_enrichment_enabled = (SELECT u.apify_enrichment_enabled FROM users u WHERE u.id = auth.uid())
    AND diff_analysis_enabled = (SELECT u.diff_analysis_enabled FROM users u WHERE u.id = auth.uid())
  );
