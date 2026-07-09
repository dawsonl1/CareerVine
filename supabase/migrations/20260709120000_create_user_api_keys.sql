CREATE TABLE user_api_keys (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'openai',
  encrypted_key text NOT NULL,
  key_last4 text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invalid', 'quota_exceeded')),
  last_validated_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_api_keys_service_role_all" ON user_api_keys
  FOR ALL USING (auth.role() = 'service_role');

REVOKE ALL ON user_api_keys FROM anon, authenticated;
