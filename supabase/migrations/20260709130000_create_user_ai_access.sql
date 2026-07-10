-- CAR-26: shared-token access entitlement.
--
-- Gates access to CareerVine's shared OpenAI key. Default is OFF: a user with
-- no row (or shared_access = false) must bring their own key. Access is granted
-- selectively via the admin route (POST /api/admin/ai-access). This is the
-- mechanism that turns silent fallback into a real, surfaced failure — a user
-- with no personal key and no shared access hits a graceful "add your key" state
-- instead of transparently spending the app owner's credits.

CREATE TABLE user_ai_access (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_access boolean NOT NULL DEFAULT false,  -- default OFF: no row / false = must BYO
  granted_at    timestamptz,                      -- when shared_access last set true
  granted_by    text,                             -- free-text audit note, e.g. 'admin:dawson'
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_ai_access ENABLE ROW LEVEL SECURITY;

-- Same posture as user_api_keys: only the service-role (server-side) client may
-- touch this table. Browser roles get nothing — entitlement is resolved server
-- side during OpenAI key routing, never trusted from the client.
CREATE POLICY "user_ai_access_service_role_all" ON user_ai_access
  FOR ALL USING (auth.role() = 'service_role');

-- Belt and suspenders: even if a permissive policy is added by mistake later,
-- client roles have no table grants — access fails loudly, not silently-empty.
REVOKE ALL ON user_ai_access FROM anon, authenticated;
