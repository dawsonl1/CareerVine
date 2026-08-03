-- CAR-213: capture the account holder's school, so the product stops assuming
-- everyone is a BYU student or alum.
--
-- The gate this feeds: a user with a BYU-family school keeps today's full
-- experience; anyone else gets the curated bundle with its alumni-only
-- prospects filtered out and no BYU highlighting anywhere.
--
-- Blank is a THIRD state, not a synonym for "not BYU" (Dawson, 2026-07-28): a
-- user who has claimed no school gets no alumni and no highlighting, because
-- the product has no basis for a school-based claim. See
-- careervine/src/lib/schools/affinity.ts, which is the authority for the rule.

-- ── 1. The columns ────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS university text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS university_is_custom boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.university IS
  'Account holder''s school (CAR-213). NULL = not claimed, which is NOT the same as "not BYU": it means no school highlighting and no alumni in the bundle, because there is nothing to base a claim on. User-writable.';
COMMENT ON COLUMN users.university_is_custom IS
  'True when the user typed a school that is not on the curated list (CAR-213). Exists so popular custom values can be folded into the list later; a value appearing 5+ times gets promoted.';

-- ── 2. Backfill: every existing account predates the question ──────────
-- Today's de-facto assumption IS BYU — every surface in the product hardcodes
-- it — so grandfathering to BYU makes this migration a no-op for every live
-- user. Only accounts created after the new signup form deploys get the new
-- treatment. Flipping this to NULL instead would silently strip alumni
-- highlighting from every account on the platform, including ones whose owners
-- really are BYU students.
UPDATE users SET university = 'Brigham Young University' WHERE university IS NULL;

-- ── 3. User-writable, via column GRANT ────────────────────────────────
-- Column privileges are the gate (20260709140000 revoked blanket UPDATE) and
-- the users_update_own policy already scopes rows to auth.uid(). Deliberately
-- NOT touching that policy: its WITH CHECK pins the admin-only columns, and a
-- DROP+CREATE here would have to re-list every one of them or silently unpin
-- whichever it missed.
GRANT UPDATE (university, university_is_custom) ON users TO authenticated;

-- ── 4. Signup trigger carries the field through ───────────────────────
-- Rewritten in full because CREATE OR REPLACE has no partial form. Preserves
-- the CAR-68 onboarding to-do below verbatim; do not drop it when editing.
--
-- THE DEPLOY-WINDOW GRANDFATHER (the `?` branch): migrations apply BEFORE the
-- merge that deploys the new signup form (rule 42), so for a few minutes the
-- OLD form is live against the NEW schema and sends no university key at all.
-- Those users predate the question exactly like the step-2 backfill population
-- does, and must be grandfathered the same way — otherwise they land on the
-- non-affinity path permanently without ever being asked.
--
-- Key PRESENCE is what separates the two cases, which is why this tests `?`
-- rather than NULL-ness, and it closes the window automatically the moment the
-- new client deploys:
--   key absent            → pre-CAR-213 client → grandfather to BYU
--   key present but empty → user was asked and declined → NULL
-- CONTRACT: the new signup form must ALWAYS send `university`, empty string
-- included. auth-provider.tsx's signUp() owns that; breaking it silently
-- re-grandfathers every blank answer to BYU.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, first_name, last_name, email, university)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'last_name', ''),
    NEW.email,
    CASE
      WHEN NEW.raw_user_meta_data ? 'university'
        THEN NULLIF(btrim(NEW.raw_user_meta_data ->> 'university'), '')
      ELSE 'Brigham Young University'
    END
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
