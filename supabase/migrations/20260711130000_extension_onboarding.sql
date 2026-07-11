-- CAR-68: extension onboarding — seeded home-page to-do + guided LinkedIn
-- import & Apollo email flow. Additive to CAR-50's guided flow.

-- 1. Flow state on users (CAR-50 precedent: onboarding_state lives here too).
--    States mirror the FigJam's resume points:
--      not_started            — to-do seeded, flow never opened past the intro
--      started                — clicked Start; on the tedium-explainer step
--      awaiting_connect       — store opened; waiting for the extension to log in
--      awaiting_first_contact — extension connected; waiting for first import
--      email_offer            — first contact imported; congrats + Apollo offer
--      apollo_intro           — said yes; Apollo explainer
--      apollo_install         — Apollo store step
--      apollo_howto           — Apollo usage video step
--      awaiting_email_contact — waiting for an extension import that has an email
--      done                   — full flow finished (terminal)
--      completed_no_apollo    — declined Apollo, jumped to their contact (terminal)
--    Transitions are enforced forward-only in the app layer, not here.
ALTER TABLE users ADD COLUMN extension_onboarding_state text NOT NULL DEFAULT 'not_started'
  CHECK (extension_onboarding_state IN (
    'not_started', 'started', 'awaiting_connect', 'awaiting_first_contact',
    'email_offer', 'apollo_intro', 'apollo_install', 'apollo_howto',
    'awaiting_email_contact', 'done', 'completed_no_apollo'
  ));

-- First contact imported during the flow — target of the end-of-flow redirect.
ALTER TABLE users ADD COLUMN extension_onboarding_contact_id bigint
  REFERENCES contacts(id) ON DELETE SET NULL;

-- Stamped by the API layer on every Bearer-authenticated extension call; the
-- "log in to the extension" step polls this to detect the connection.
ALTER TABLE users ADD COLUMN extension_last_seen_at timestamptz;

-- No backfill: existing accounts keep not_started but are never seeded the
-- to-do row (trigger below only fires for new signups), so the flow never
-- surfaces for them.

-- Client advances the flow and the API wrapper stamps last-seen with the
-- user's own RLS-scoped session, so all three columns are user-writable
-- (same gate as onboarding_state; users_update_own scopes rows to auth.uid()).
GRANT UPDATE (extension_onboarding_state, extension_onboarding_contact_id, extension_last_seen_at)
  ON users TO authenticated;

COMMENT ON COLUMN users.extension_onboarding_state IS 'Extension onboarding flow progress (CAR-68). User-writable; forward-only transitions enforced in the app.';
COMMENT ON COLUMN users.extension_last_seen_at IS 'Last Bearer-authenticated extension API call (CAR-68); stamped in api-handler.';

-- 2. Seed the default to-do for every new account. Extends the CAR-50-era
--    signup trigger; SECURITY DEFINER bypasses RLS for the insert.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, first_name, last_name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'last_name', ''),
    NEW.email
  )
  ON CONFLICT (id) DO NOTHING;

  -- CAR-68: default onboarding to-do. contact_id NULL + source 'onboarding'
  -- is what the home page keys on to open the guided extension flow.
  -- created_at has no column default; set it so age-based UI stays correct.
  INSERT INTO public.follow_up_action_items (user_id, contact_id, title, description, due_at, is_completed, source, created_at)
  VALUES (
    NEW.id,
    NULL,
    'Download the LinkedIn scraping Chrome extension to import your first contact',
    'A 3-minute guided setup — install the extension and add your first contact straight from LinkedIn.',
    NULL,
    false,
    'onboarding',
    now()
  );

  RETURN NEW;
END;
$$;

-- 3. Cleanup: the 2026-03-26 floating-card onboarding design was abandoned
--    before any UI shipped; nothing references its table or flag column.
DROP TABLE IF EXISTS user_onboarding;
ALTER TABLE email_messages DROP COLUMN IF EXISTS is_simulated;
