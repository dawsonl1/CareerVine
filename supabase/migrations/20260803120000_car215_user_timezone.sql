-- CAR-215: a real per-user IANA timezone, and the removal of the default that
-- has been impersonating one.
--
-- Background. `gmail_connections.calendar_timezone` was added in
-- 20260218090000_google_calendar_integration.sql with
-- `DEFAULT 'America/New_York'`. The column is only ever populated for real by
-- the calendar sync route, and only on FIRST sync (the write is gated on
-- `calendar_last_synced_at IS NULL`). Every connection that never completed a
-- sync therefore reads Eastern whether or not the user has ever been near it.
--
-- That is not a cosmetic problem. `/api/calendar/availability` reads
-- `calendar_timezone || DEFAULT_TIMEZONE` — and DEFAULT_TIMEZONE is ALSO
-- America/New_York — so those users are currently offered meeting slots in the
-- wrong zone. At the time of writing, 4 of 8 connections read America/New_York
-- and only ONE of them is real; one of the fakes is an account whose sibling row
-- (same person, second login) says America/Edmonton.
--
-- Three changes, in dependency order.

-- 1. The authoritative per-user zone. Deliberately NULLABLE with NO DEFAULT:
--    the entire bug being fixed here is a default value that reads as data.
--    NULL means "we have not learned it yet", which callers must handle
--    explicitly rather than silently inheriting somebody else's coast.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text;

-- Stamped from api-handler's cookie/web branch using the user's OWN RLS-scoped
-- session, alongside the throttled web_last_seen_at write. Like that column
-- (and extension_last_seen_at before it), it needs an explicit column GRANT or
-- the stamp silently no-ops under the users-table UPDATE revoke in
-- 20260709140000_admin_dashboard_foundation.sql. Not a privilege/entitlement
-- column, and users_update_own already scopes rows to auth.uid(), so no
-- WITH CHECK pin is needed.
GRANT UPDATE (timezone) ON users TO authenticated;

COMMENT ON COLUMN users.timezone IS
  'CAR-215: the user''s real IANA timezone (e.g. America/Denver), captured from the browser via the X-CV-Timezone header and stamped by api-handler. NULL = not yet observed; never guess a default, that is the bug this column replaces.';

-- 2. Stop minting fake timezones. New connections now start NULL and stay NULL
--    until a calendar sync learns the real value.
ALTER TABLE gmail_connections ALTER COLUMN calendar_timezone DROP DEFAULT;

-- 3. Clear the values that were never data in the first place. The timezone
--    fetch is gated on `calendar_last_synced_at IS NULL`, so a row that never
--    stamped that column never had its zone read from Google, and whatever it
--    holds is the column default.
--
--    Narrow, acknowledged imprecision: if a first sync fetched a real zone and
--    then failed before stamping calendar_last_synced_at, this nulls a real
--    value. That is self-healing (the fetch gate is still open, so the next
--    sync re-reads it from Google) and harmless (users.timezone now carries the
--    authoritative answer regardless).
UPDATE gmail_connections
   SET calendar_timezone = NULL
 WHERE calendar_last_synced_at IS NULL;

COMMENT ON COLUMN gmail_connections.calendar_timezone IS
  'The zone Google Calendar reports for this connection, read once on first sync. NULL = never synced. CAR-215 dropped its America/New_York DEFAULT: an unsynced row used to read Eastern and was indistinguishable from a genuine Eastern user. Prefer users.timezone for send-time decisions; this one is about the calendar account, not the person.';
