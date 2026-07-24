-- CAR-178: make the PostgREST role grants explicit.
--
-- Historically Supabase auto-granted anon/authenticated/service_role full DML
-- on everything in public (legacy auto-expose). The platform default flipped:
-- new entities get NO grants unless config `auto_expose_new_tables = true`,
-- and that toggle is deprecated with removal scheduled for 2026-10-30 (see
-- supabase/config.toml). Production still works because this project predates
-- the cutover, but a fresh local stack built from the migration chain has no
-- DML grants at all — which is how the CAR-178 integration tier surfaced
-- this: even the service role got "permission denied for table companies".
--
-- Codify the grants the app has always relied on, plus default privileges so
-- tables added by FUTURE migrations keep working after the legacy toggle is
-- removed. Grants are orthogonal to RLS: anon/authenticated remain fully
-- gated by the row policies; service_role bypasses RLS as designed. This is
-- idempotent and a no-op on production's existing grants.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

-- Objects created by future migrations (which run as postgres).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
