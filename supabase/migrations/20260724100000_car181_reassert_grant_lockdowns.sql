-- CAR-181: re-assert the security lockdowns that CAR-178's blanket grant reversed.
--
-- 20260724091000_car178_explicit_postgrest_grants.sql ran
--   GRANT ALL ON ALL TABLES/FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role
-- to codify the DML grants a fresh local stack needs (the integration tier
-- had no grants at all). That was necessary but too broad: GRANT ALL re-granted
-- privileges that ~14 earlier migrations had deliberately REVOKED for security,
-- and — because CAR-178 granted the anon/authenticated ROLES explicitly (not via
-- PUBLIC) — the original `REVOKE ... FROM PUBLIC` lockdowns no longer cover them.
--
-- This migration restores the intended grant set per object. It runs AFTER
-- CAR-178 in the chain, so it wins. Verified end state (has_function_privilege /
-- has_table_privilege) is asserted by src/__integration__/rls-tenant-isolation
-- .itest.ts, so a future re-reversal fails CI.
--
-- The most severe reversals were SECURITY DEFINER functions (which ignore RLS):
-- apply_bundle_resolutions and replace_transcript_segments became anon-callable
-- unauthenticated cross-tenant WRITE primitives. Those are closed first.

-- ── SECURITY DEFINER functions: service_role-only (anon + authenticated revoked) ──

-- apply_bundle_resolutions: service path only (bundle resolver). SECURITY DEFINER,
-- no internal auth check — must never be reachable by a browser role.
REVOKE EXECUTE ON FUNCTION apply_bundle_resolutions(p_rows jsonb) FROM anon, authenticated;

-- increment_ai_shared_usage: the shared-AI spend meter (CAR-143). service-only so
-- a user cannot manipulate their own spend counter.
REVOKE EXECUTE ON FUNCTION increment_ai_shared_usage(p_user_id uuid, p_period_start date, p_cost numeric) FROM anon, authenticated;

-- user_is_internal: SECURITY DEFINER internal-allowlist check (CAR internal
-- analytics). service-only.
REVOKE EXECUTE ON FUNCTION user_is_internal(uid uuid) FROM anon, authenticated;

-- is_internal_email: revoked from PUBLIC at creation, never granted to a browser
-- role. Keep it that way.
REVOKE EXECUTE ON FUNCTION is_internal_email(p_email text) FROM anon, authenticated;

-- ── SECURITY DEFINER / authenticated-intended functions: revoke anon only ──

-- replace_transcript_segments: SECURITY DEFINER, DELETE+INSERT transcript_segments
-- by meeting_id with no internal auth check. Intended: authenticated (a signed-in
-- user replacing their own meeting's transcript). anon must not reach it.
REVOKE EXECUTE ON FUNCTION replace_transcript_segments(p_meeting_id integer, p_segments jsonb) FROM anon;

-- bundle_alumni_stats / user_company_alumni_counts / bundle_company_stats:
-- authenticated + service_role only (revoked from public, anon at creation).
REVOKE EXECUTE ON FUNCTION bundle_alumni_stats(p_bundle_id integer) FROM anon;
REVOKE EXECUTE ON FUNCTION user_company_alumni_counts() FROM anon;
REVOKE EXECUTE ON FUNCTION bundle_company_stats(p_bundle_id integer) FROM anon;

-- network_tier_counts / save_pipeline_cycle / delete_pipeline_cycle:
-- authenticated only (revoked from public/anon at creation).
REVOKE EXECUTE ON FUNCTION network_tier_counts() FROM anon;
REVOKE EXECUTE ON FUNCTION save_pipeline_cycle(p_target_company_id integer, p_cycle_number integer, p_payload jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION delete_pipeline_cycle(p_target_company_id integer, p_cycle_number integer) FROM anon;

-- ── Tables locked to service-only (RLS-gated, but the deliberate no-grant stands) ──

REVOKE ALL ON user_api_keys FROM anon, authenticated;
REVOKE ALL ON user_ai_access FROM anon, authenticated;
REVOKE ALL ON bundle_access_overrides FROM anon, authenticated;
REVOKE ALL ON admin_audit_log FROM anon, authenticated;

-- ai_shared_usage: authenticated keeps SELECT (its own-row RLS policy needs the
-- grant to be usable); only writes were locked (CAR-143).
REVOKE INSERT, UPDATE, DELETE ON ai_shared_usage FROM anon, authenticated;

-- ── Column-scoped tables: revoke the blanket grant, restore the exact columns ──

-- gmail_connections (CAR-27 + send_scope_granted): the browser role may read only
-- non-secret metadata columns; access_token / refresh_token / token_expires_at
-- stay unreadable. anon gets nothing.
REVOKE ALL ON gmail_connections FROM anon, authenticated;
GRANT SELECT (id, user_id, gmail_address, last_gmail_sync_at, created_at, send_scope_granted)
  ON gmail_connections TO authenticated;

-- users: authenticated may UPDATE only its own profile columns (assembled across
-- 20260709140000 / 20260711003000 / 20260711150000 / 20260712070000). GRANT ALL
-- had exposed UPDATE on status and the extension/feature columns; the RLS
-- WITH CHECK already pins status + the automatic-feature flags, but restore the
-- column grant to intent so nothing else is user-writable. SELECT is unchanged.
REVOKE UPDATE ON users FROM authenticated;
REVOKE ALL ON users FROM anon;
GRANT UPDATE (
  first_name, last_name, email, phone, updated_at,
  onboarding_state, dismissed_getting_started,
  web_last_seen_at, followup_nudges_enabled
) ON users TO authenticated;

-- ── Future-table footgun: stop auto-granting anon EXECUTE on new functions ──
--
-- CAR-178's ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon means
-- every future function (including SECURITY DEFINER) auto-gets anon EXECUTE —
-- exactly how this class of bug would recur. Browser-anonymous should never be a
-- default function grantee. Tables keep their default grants (RLS gates them);
-- authenticated keeps the function default (most RPCs want it).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
