-- CAR-220: close due_send_counts() to the browser roles, arm the watcher alarm,
-- and correct two claims 20260803130000/20260803140000 made about themselves.
--
-- ── 1. due_send_counts() was executable by every logged-in user ─────────
--
-- 20260803130000 ended with `REVOKE ALL ON FUNCTION ... FROM PUBLIC` under the
-- comment "Not callable by the world just because it is SECURITY DEFINER". That
-- revoke is real but incomplete. Supabase ships an
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres,
-- authenticated, service_role` owned by `postgres`, and migrations run as
-- `postgres`, so the function was born with an EXPLICIT authenticated grant that
-- a revoke aimed at PUBLIC does not touch.
--
-- Observed, not inferred. On both production and a freshly reset local stack:
--
--   proacl = {postgres=X/postgres,authenticated=X/postgres,
--             service_role=X/postgres,careervine_watcher=X/postgres}
--
-- and, as the `authenticated` role, `SELECT * FROM public.due_send_counts()`
-- returned rows. Since the function is SECURITY DEFINER and bypasses RLS, any
-- signed-in user could POST /rest/v1/rpc/due_send_counts and read platform-wide
-- pending-send counts: a cross-tenant aggregate, and a side channel they could
-- poll to watch other tenants' queues drain.

REVOKE ALL ON FUNCTION public.due_send_counts()
  FROM PUBLIC, anon, authenticated, service_role;

-- service_role is revoked rather than kept, deliberately. It holds BYPASSRLS and
-- full table grants, so it can already compute both counts straight from
-- scheduled_emails / email_follow_up_messages; the EXECUTE grant adds no
-- capability, and nothing in the app calls this function (the only caller is
-- ops/send-watcher/send_watcher.py, which connects as careervine_watcher). What
-- revoking buys is that the remaining ACL names exactly one intended executor,
-- so the grant guard can assert an exact set instead of a superset. If app code
-- ever needs these counts, query the tables with the service client rather than
-- re-granting this.

-- Re-assert the one grant that matters, so this file is self-contained if the
-- function is ever dropped and recreated (which restores the default grants).
GRANT EXECUTE ON FUNCTION public.due_send_counts() TO careervine_watcher;

COMMENT ON FUNCTION public.due_send_counts() IS
  'CAR-215: how many scheduled emails / follow-up steps are due right now, mirroring the send crons'' own due conditions. Exists so the A1 watcher can decide whether to trigger a send sweep without holding any table privileges. CAR-220: EXECUTE is careervine_watcher only — REVOKE FROM PUBLIC does not remove Supabase''s default authenticated grant, so any new revoke must name the roles explicitly.';

-- ── 2. The "belt and braces" default-privileges line was a no-op ────────
--
-- 20260803130000 ended with:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES
--     FROM careervine_watcher;
--
-- commented as protection "so a future blanket `GRANT ... ON ALL TABLES IN
-- SCHEMA public` does not quietly hand this role the queue contents". It does
-- not do that, for two independent reasons, both checked against the local stack
-- after the migration had been applied:
--
--   a. Default privileges are a positive-grant system: an ALTER DEFAULT
--      PRIVILEGES REVOKE only cancels a matching prior ALTER DEFAULT PRIVILEGES
--      GRANT. Nobody ever granted tables to careervine_watcher by default, so
--      the statement recorded nothing — `pg_default_acl` holds zero rows
--      mentioning the role.
--   b. Even a correctly recorded entry would not have helped, because default
--      privileges govern objects created LATER by the grantor, while
--      `GRANT ... ON ALL TABLES` acts on objects that already exist. The two
--      never meet. Running that GRANT inside a transaction did in fact give
--      careervine_watcher SELECT on scheduled_emails, with the old line applied.
--
-- Nothing here can be "fixed" by a better ALTER DEFAULT PRIVILEGES, so the line
-- is replaced by the statement that actually acts on the state it claimed to
-- protect, plus a test. This is a no-op today (the role holds nothing) and is
-- written so that being a no-op is asserted rather than assumed.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM careervine_watcher;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM careervine_watcher;
-- USAGE on the schema stays: without it the role cannot resolve, let alone call,
-- due_send_counts().

-- No SQL can pre-empt a blanket GRANT written in a future migration. The durable
-- guard is careervine/src/__integration__/grant-lockdowns.itest.ts, which runs
-- against the migrated database and fails if this role ever acquires a table
-- privilege or if a browser role acquires EXECUTE here.

-- ── 3. Seed the send-watcher heartbeat, so "no row" stops being valid ───
--
-- checkWatcherHealth() (careervine/src/lib/watcher-health.ts) returns idle when
-- the row is absent, documented as "the state before the watcher has ever run".
-- The consequence was that the alarm could never arm for the failure that
-- matters most: a watcher that has NEVER successfully authenticated writes no
-- row, reads as "not provisioned yet" forever, and the QStash safety net stays
-- silent while delivery quietly runs an hour late.
--
-- Seeding at now() rather than in the past gives a deploying watcher the full
-- WATCHER_STALE_MINUTES window (40 min) to check in before the first alert can
-- fire, so this arms the alarm without manufacturing a false one. ON CONFLICT DO
-- NOTHING keeps a live stamp intact if the watcher is already running.

INSERT INTO cron_heartbeats (name, last_seen_at)
VALUES ('send-watcher', now())
ON CONFLICT (name) DO NOTHING;

-- ── 4. Make the cron_heartbeats policy re-runnable ──────────────────────
--
-- 20260803140000 used a bare CREATE POLICY, so re-running it aborts with
-- "policy ... already exists" (42710) — verified by re-running it in a
-- transaction. Everything else in that file is IF NOT EXISTS / OR REPLACE, so
-- the file reads as idempotent and is not. Same name and same predicate; only
-- the re-runnability changes.

DROP POLICY IF EXISTS "Service role full access to cron_heartbeats" ON cron_heartbeats;
CREATE POLICY "Service role full access to cron_heartbeats"
  ON cron_heartbeats FOR ALL USING (auth.role() = 'service_role');
