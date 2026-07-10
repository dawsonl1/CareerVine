-- Plan 32 merge reconciliation: drop users.ai_fallback_policy.
--
-- The admin-dashboard branch and CAR-26 landed parallel implementations of
-- shared-key control. CAR-26's user_ai_access entitlement (default OFF,
-- fail-closed, wired to the graceful AI-failure UI) is the surviving model;
-- the admin dashboard now grants/revokes user_ai_access.shared_access.
-- users.ai_fallback_policy (added in 20260709140000, never read by shipped
-- code) is dead schema — remove it rather than leave a second source of truth.

-- The self-update policy pins this column, so rewrite it first (keep the
-- status pin; the column-privilege GRANT never included either column).
DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own" ON users
  FOR UPDATE USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND status = (SELECT u.status FROM users u WHERE u.id = auth.uid())
  );

ALTER TABLE users DROP COLUMN ai_fallback_policy;
