-- Plan 32: Admin Dashboard & User Management — foundation
-- Introduces the first authorization layer over the app: account status,
-- per-account AI fallback policy, per-(user,bundle) visibility, and an admin
-- audit trail. The admin *identity* itself lives in auth.users.app_metadata.role
-- (set by scripts/grant-admin.mjs / the in-app make-admin control), not here —
-- app_metadata is service-role-only, so a user cannot self-promote.

-- ═══════════════════════════════════════════════════════════
-- 1. users: account status + AI fallback policy
-- ═══════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended'));

-- DEFAULT 'shared' PRESERVES today's unconditional shared-key fallback for every
-- existing user. 'cutoff' (no shared fallback → hard AI error) is an explicit
-- per-account admin choice. Defaulting to 'cutoff' would knock AI offline for
-- every keyless user the moment the policy-aware resolver ships.
ALTER TABLE users ADD COLUMN ai_fallback_policy text NOT NULL DEFAULT 'shared'
  CHECK (ai_fallback_policy IN ('cutoff', 'shared'));

COMMENT ON COLUMN users.status IS 'active | suspended. Suspended = frozen: blocked from login and skipped by server-side automation. Writable only by the service role.';
COMMENT ON COLUMN users.ai_fallback_policy IS 'shared = fall back to the shared CareerVine key when the user key is missing/invalid/exhausted (default, = legacy behavior); cutoff = return a typed AI error instead. Writable only by the service role.';

-- ── Self-escalation guard ──────────────────────────────────────────────────
-- Primary defense: column privileges. authenticated may UPDATE only profile
-- columns, never status / ai_fallback_policy. RLS can't cheaply restrict WHICH
-- columns an UPDATE touches; column grants can.
REVOKE UPDATE ON users FROM authenticated;
GRANT  UPDATE (first_name, last_name, email, phone, updated_at) ON users TO authenticated;

-- Secondary belt-and-suspenders: pin the privileged columns to their current
-- value in the RLS WITH CHECK too (correlated sub-select reads the pre-UPDATE
-- snapshot under READ COMMITTED, so new must equal old).
DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND status             = (SELECT u.status             FROM users u WHERE u.id = auth.uid())
    AND ai_fallback_policy = (SELECT u.ai_fallback_policy FROM users u WHERE u.id = auth.uid())
  );

-- ═══════════════════════════════════════════════════════════
-- 2. Bundle visibility (hidden-until-granted)
-- ═══════════════════════════════════════════════════════════
-- New bundles are hidden by default; existing PUBLISHED bundles are backfilled
-- visible so nobody loses access to what they can see today.
ALTER TABLE data_bundles ADD COLUMN default_visible boolean NOT NULL DEFAULT false;
UPDATE data_bundles SET default_visible = true WHERE status = 'published';

COMMENT ON COLUMN data_bundles.default_visible IS 'false (default) = hidden until an admin grants an allowed=true override; true = broadly visible. Per-account overrides in bundle_access_overrides win either way.';

-- Per-(user, bundle) visibility override. Service-role-only (admin writes it).
CREATE TABLE bundle_access_overrides (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bundle_id  int  NOT NULL REFERENCES data_bundles(id) ON DELETE CASCADE,
  allowed    boolean NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bundle_id)
);

COMMENT ON TABLE bundle_access_overrides IS 'Per-account bundle visibility override. allowed=true grants a hidden bundle; allowed=false hides a default-visible one. Absence = data_bundles.default_visible. Service-role write only.';

ALTER TABLE bundle_access_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bundle_access_overrides_service_role_all" ON bundle_access_overrides
  FOR ALL USING (auth.role() = 'service_role');
REVOKE ALL ON bundle_access_overrides FROM anon, authenticated;

-- One shared visibility predicate used by every bundle policy. SECURITY DEFINER
-- so it can read the service-role-only overrides table from inside a policy that
-- is evaluated as the authenticated user.
CREATE OR REPLACE FUNCTION bundle_visible_to(p_bundle_id int, p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM bundle_access_overrides o
      WHERE o.bundle_id = p_bundle_id AND o.user_id = p_user AND o.allowed = false
    ) THEN false
    WHEN EXISTS (
      SELECT 1 FROM bundle_access_overrides o
      WHERE o.bundle_id = p_bundle_id AND o.user_id = p_user AND o.allowed = true
    ) THEN true
    ELSE COALESCE((SELECT b.default_visible FROM data_bundles b WHERE b.id = p_bundle_id), false)
  END;
$$;

COMMENT ON FUNCTION bundle_visible_to(int, uuid) IS 'Effective bundle visibility for a user: explicit override wins (deny beats grant), else the bundle default. Used by the bundle RLS policies.';

-- ── Rewrite bundle RLS so visibility is enforced at the DATA layer ─────────
-- The API list-route filter alone is bypassable via the browser client; these
-- policies are the real boundary.
DROP POLICY IF EXISTS "data_bundles_select_published" ON data_bundles;
CREATE POLICY "data_bundles_select_published" ON data_bundles
  FOR SELECT TO authenticated
  USING (status = 'published' AND bundle_visible_to(id, auth.uid()));

DROP POLICY IF EXISTS "bundle_prospects_select_subscribed" ON bundle_prospects;
CREATE POLICY "bundle_prospects_select_subscribed" ON bundle_prospects
  FOR SELECT TO authenticated USING (
    bundle_visible_to(bundle_id, auth.uid())
    AND EXISTS (
      SELECT 1 FROM bundle_subscriptions bs
      WHERE bs.bundle_id = bundle_prospects.bundle_id
        AND bs.user_id = auth.uid()
        AND bs.status = 'active'
    )
  );

DROP POLICY IF EXISTS "bundle_companies_select_subscribed" ON bundle_companies;
CREATE POLICY "bundle_companies_select_subscribed" ON bundle_companies
  FOR SELECT TO authenticated USING (
    bundle_visible_to(bundle_id, auth.uid())
    AND EXISTS (
      SELECT 1 FROM bundle_subscriptions bs
      WHERE bs.bundle_id = bundle_companies.bundle_id
        AND bs.user_id = auth.uid()
        AND bs.status = 'active'
    )
  );

-- Can't self-subscribe (via the browser client) to a bundle you're not allowed
-- to see. Unsubscribe (an UPDATE to status) is intentionally left permissive so
-- a user can always leave a bundle that was later hidden.
DROP POLICY IF EXISTS "bundle_subscriptions_insert_own" ON bundle_subscriptions;
CREATE POLICY "bundle_subscriptions_insert_own" ON bundle_subscriptions
  FOR INSERT WITH CHECK (
    user_id = auth.uid() AND bundle_visible_to(bundle_id, auth.uid())
  );

-- ═══════════════════════════════════════════════════════════
-- 3. admin_audit_log — who did what to whom
-- ═══════════════════════════════════════════════════════════
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid NOT NULL REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  action  text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE admin_audit_log IS 'Append-only trail of admin actions on user accounts. Written via the service role from lib/admin.ts writeAudit().';

CREATE INDEX admin_audit_log_target_idx ON admin_audit_log (target_user_id, created_at DESC);

ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_audit_log_service_role_all" ON admin_audit_log
  FOR ALL USING (auth.role() = 'service_role');
REVOKE ALL ON admin_audit_log FROM anon, authenticated;
