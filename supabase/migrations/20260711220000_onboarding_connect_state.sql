-- CAR-82: dedicated "Connect Gmail & Calendar" onboarding step. Add the
-- `connect` resume point (between not_started and syncing) so a user who
-- closes the tab on the connect step resumes there rather than skipping past
-- it into the company picker. The column is a plain text + CHECK (added in
-- 20260711003000); extend the allowed set. No existing row can hold 'connect',
-- so this only widens what's accepted — no data change, no lock beyond the
-- brief constraint revalidation.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_onboarding_state_check;
ALTER TABLE users ADD CONSTRAINT users_onboarding_state_check
  CHECK (onboarding_state IN ('not_started', 'connect', 'syncing', 'pick_company', 'outreach', 'completed', 'skipped'));

COMMENT ON COLUMN users.onboarding_state IS 'Guided first-run onboarding progress (CAR-50, +connect step CAR-82). User-writable; forward-only transitions enforced in the app.';
