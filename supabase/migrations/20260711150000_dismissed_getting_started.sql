-- CAR-73: let users dismiss individual getting-started checklist items on Home.
--
-- The "Up Next" empty state renders a hardcoded getting-started checklist
-- (GettingStartedList in unified-action-list.tsx) to brand-new accounts. The
-- rows were stateless nav shortcuts with nowhere to record "I dismissed this",
-- so a user couldn't remove one they don't want. This column stores the set of
-- dismissed row IDs (stable strings: 'getting-started-bundle',
-- 'getting-started-company', 'getting-started-calendar',
-- 'getting-started-extension', 'getting-started-log'). Default '{}' is correct
-- for every existing account — nothing dismissed yet — so no backfill.
ALTER TABLE users ADD COLUMN dismissed_getting_started text[] NOT NULL DEFAULT '{}';

-- User-writable, same gate as onboarding_state / extension_onboarding_state:
-- the client writes the full array as the user dismisses rows. Column-level
-- GRANT is the switch (20260709140000 revoked blanket UPDATE); the
-- users_update_own policy already scopes rows to auth.uid().
GRANT UPDATE (dismissed_getting_started) ON users TO authenticated;

COMMENT ON COLUMN users.dismissed_getting_started IS 'Getting-started checklist row IDs the user dismissed on Home (CAR-73). User-writable.';
