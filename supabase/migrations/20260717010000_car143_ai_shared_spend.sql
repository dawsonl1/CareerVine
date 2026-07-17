-- CAR-143 (R5.3): persisted per-user spend ceiling for the SHARED OpenAI key.
--
-- The in-memory rate limits reset on every deploy/cold start and the 24h trial
-- only bounds *when* a user can spend, not *how much* — so a hot loop (or an
-- abusive client) inside a valid entitlement window could spend the app
-- owner's OpenAI credits without bound. This table gives the OpenAIRunner
-- chokepoint a durable monthly counter it checks before every shared-key call
-- and increments after each one. BYO-key calls never touch it.
--
-- Rows are written exclusively by the service client via the RPC below; users
-- can read their own row (future UI: "shared AI usage this month").

CREATE TABLE ai_shared_usage (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  estimated_cost_usd numeric NOT NULL DEFAULT 0,
  call_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_start)
);

COMMENT ON TABLE ai_shared_usage IS 'Per-user, per-month estimated spend on the shared OpenAI key (CAR-143 R5.3). Checked fail-closed before every shared-key call.';

ALTER TABLE ai_shared_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_shared_usage_select_own" ON ai_shared_usage
  FOR SELECT USING (user_id = auth.uid());
-- Writes happen only through the service client (the RPC below), so no
-- user-facing insert/update policy.

-- Atomic increment: upsert-add so concurrent AI calls never lose updates.
CREATE OR REPLACE FUNCTION increment_ai_shared_usage(
  p_user_id uuid,
  p_period_start date,
  p_cost numeric
)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO ai_shared_usage (user_id, period_start, estimated_cost_usd, call_count, updated_at)
  VALUES (p_user_id, p_period_start, p_cost, 1, now())
  ON CONFLICT (user_id, period_start) DO UPDATE SET
    estimated_cost_usd = ai_shared_usage.estimated_cost_usd + EXCLUDED.estimated_cost_usd,
    call_count = ai_shared_usage.call_count + 1,
    updated_at = now();
$$;

-- Supabase default-grants EXECUTE on public functions to anon/authenticated
-- (PostgREST exposes them at /rpc). Only the service client may meter spend:
-- without this REVOKE the call is blocked merely by the incidental absence of
-- an INSERT policy on the RLS'd table. Belt and suspenders, matching the
-- repo convention (apply_bundle_resolutions, user_ai_access hardening).
REVOKE ALL ON FUNCTION increment_ai_shared_usage(uuid, date, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION increment_ai_shared_usage(uuid, date, numeric) TO service_role;
REVOKE INSERT, UPDATE, DELETE ON ai_shared_usage FROM anon, authenticated;
