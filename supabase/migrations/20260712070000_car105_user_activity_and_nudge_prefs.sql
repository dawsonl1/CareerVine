-- CAR-105 Phase A/B: web last-active signal + nudge opt-out preference.
--
-- web_last_seen_at: there is no "active in the web app" timestamp today (only
-- extension_last_seen_at, extension-only). The active-aware expiry rule needs one.
-- Stamped (throttled) from api-handler's cookie/web branch using the user's OWN
-- RLS-scoped session — so, exactly like extension_last_seen_at (CAR-68), it needs
-- an explicit column GRANT or the stamp silently no-ops under the users-table
-- UPDATE revoke (20260709140000_admin_dashboard_foundation.sql).
--
-- followup_nudges_enabled: opt-out for the CAR-105 reminder emails. Default true.
-- User-writable so the settings toggle works from the browser client; the
-- unauthenticated one-click unsubscribe route writes it via the service client.

ALTER TABLE users ADD COLUMN IF NOT EXISTS web_last_seen_at timestamptz;

ALTER TABLE users ADD COLUMN IF NOT EXISTS followup_nudges_enabled boolean NOT NULL DEFAULT true;

-- Both are user-writable via the RLS-scoped session (users_update_own scopes rows
-- to auth.uid()); neither is a privilege/entitlement column, so no WITH CHECK pin
-- is needed (mirrors extension_last_seen_at + dismissed_getting_started).
GRANT UPDATE (web_last_seen_at, followup_nudges_enabled) ON users TO authenticated;

COMMENT ON COLUMN users.web_last_seen_at IS
  'CAR-105: last authenticated WEB app activity (distinct from extension_last_seen_at); throttled stamp from api-handler. Feeds the active-aware follow-up expiry.';
COMMENT ON COLUMN users.followup_nudges_enabled IS
  'CAR-105: opt-in (default true) for the follow-up reminder emails. Toggled in settings or via one-click unsubscribe.';
