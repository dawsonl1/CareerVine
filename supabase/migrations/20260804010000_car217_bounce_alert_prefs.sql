-- CAR-217: opt-out preference for the bounce alert emails.
--
-- A bounce alert is operational rather than a reminder: it says an address has
-- permanently stopped accepting mail, and that CareerVine has cancelled what was
-- queued to it. It therefore gets its OWN column rather than riding on
-- followup_nudges_enabled (20260712070000) -- a user who silences follow-up
-- reminders has not asked to stop being told their outreach is undeliverable.
--
-- Additive, nullable-with-default, and read by code that ships alongside it, so
-- it is safe to apply before the deploy (rule 42): old code never selects it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS bounce_alerts_enabled boolean NOT NULL DEFAULT true;

-- User-writable via the RLS-scoped session so the settings toggle works from the
-- browser client, exactly like followup_nudges_enabled; the unauthenticated
-- one-click unsubscribe route writes it through the service client instead.
--
-- This GRANT is additive to the explicit column list reasserted by
-- 20260724100000_car181_reassert_grant_lockdowns.sql, which REVOKEd the blanket
-- UPDATE on users and re-granted an exact set. A new user-writable column must
-- be granted here or the settings toggle silently no-ops under that revoke.
-- Not a privilege or entitlement column, so no RLS WITH CHECK pin is needed.
GRANT UPDATE (bounce_alerts_enabled) ON users TO authenticated;

COMMENT ON COLUMN users.bounce_alerts_enabled IS
  'CAR-217: opt-in (default true) for the bounce alert emails sent when a contact address permanently rejects mail. Toggled in settings or via one-click unsubscribe. Independent of followup_nudges_enabled.';
