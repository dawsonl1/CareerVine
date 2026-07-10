-- CAR-50: guided new-user onboarding needs a persistent, resumable flow state.
-- The home page's isNewUser (contactHealth.length === 0) is ephemeral and flips
-- the moment any active contact exists, so it can't represent "show the intro
-- exactly once" or "resume mid-flow after a closed tab".
--
-- States mirror the flow's resume points:
--   not_started  — never seen the intro; gate opens the bundle-offer modal
--   syncing      — accepted the bundle; apply loop was in flight
--   pick_company — bundle applied; target company not yet chosen
--   outreach     — company targeted; first email not yet sent
--   completed    — finished the intro (or declined the bundle after the brief tour)
--   skipped      — bailed via "skip for now"
-- Transitions are enforced forward-only in the app layer, not here.
ALTER TABLE users ADD COLUMN onboarding_state text NOT NULL DEFAULT 'not_started'
  CHECK (onboarding_state IN ('not_started', 'syncing', 'pick_company', 'outreach', 'completed', 'skipped'));

-- Accounts that predate guided onboarding must never see the intro.
UPDATE users SET onboarding_state = 'completed';

-- Unlike the pinned admin switches (status, apify_*, discovery_enabled), this
-- column is user-writable: the client advances it as the user moves through
-- the flow. Column-level GRANT is the gate (20260709140000 revoked blanket
-- UPDATE); the users_update_own policy already scopes rows to auth.uid().
GRANT UPDATE (onboarding_state) ON users TO authenticated;

COMMENT ON COLUMN users.onboarding_state IS 'Guided first-run onboarding progress (CAR-50). User-writable; forward-only transitions enforced in the app.';
