-- CAR-215: a least-privilege login for the A1 send watcher.
--
-- The watcher's whole job is to answer "is anything due right now?" every ~15s
-- and, when the answer is yes, POST the existing cron route so the app does the
-- actual work. It is a clock, not a scheduler.
--
-- ── Why a function and not table grants ─────────────────────────────────
--
-- The obvious shape is column-level SELECT on the two queue tables. That still
-- exposes per-row timing and user ids, and it needs RLS policies written for a
-- non-service role (both tables have RLS on), or a BYPASSRLS role attribute
-- that would apply to everything the role can ever read.
--
-- A SECURITY DEFINER function collapses all of that: the role gets EXECUTE on
-- exactly one function and no table privileges at all. The most it can learn,
-- with the credentials sitting on a VM, is two integers. It cannot read a
-- recipient, a subject, a user id, or a send time.
--
-- ── Why the conditions are duplicated from the cron ─────────────────────
--
-- The counts mirror what the send routes actually treat as due, including the
-- suspended-account and inactive-sequence filters. If they were looser, a row
-- the cron always skips (a suspended user's held email; a message whose parent
-- sequence is no longer active) would read as permanently due and the watcher
-- would poke Vercel every 15 seconds forever. That is the one failure mode that
-- would make this cost MORE than the polling it replaces.

CREATE OR REPLACE FUNCTION public.due_send_counts()
RETURNS TABLE (scheduled_due bigint, follow_ups_due bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned search_path: a SECURITY DEFINER function without one can be hijacked
-- by a caller-controlled path resolving these table names elsewhere.
SET search_path = public, pg_temp
AS $$
  SELECT
    (
      SELECT count(*)
        FROM scheduled_emails se
        JOIN users u ON u.id = se.user_id
       WHERE se.status = 'pending'
         AND se.scheduled_send_at <= now()
         AND u.status = 'active'
    ),
    (
      SELECT count(*)
        FROM email_follow_up_messages m
        JOIN email_follow_ups f ON f.id = m.follow_up_id
        JOIN users u ON u.id = f.user_id
       WHERE m.status = 'pending'
         AND m.scheduled_send_at <= now()
         AND f.status = 'active'
         AND f.thread_id IS NOT NULL
         AND u.status = 'active'
    );
$$;

COMMENT ON FUNCTION public.due_send_counts() IS
  'CAR-215: how many scheduled emails / follow-up steps are due right now, mirroring the send crons'' own due conditions. Exists so the A1 watcher can decide whether to trigger a send sweep without holding any table privileges.';

-- Not callable by the world just because it is SECURITY DEFINER.
REVOKE ALL ON FUNCTION public.due_send_counts() FROM PUBLIC;

-- The watcher login. NOINHERIT so it can never pick up privileges by being
-- granted membership in something later; no CREATEDB/CREATEROLE/SUPERUSER.
-- Password is deliberately NOT set here: this file is committed to git. It is
-- assigned out of band and stored in the VM's systemd EnvironmentFile.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careervine_watcher') THEN
    CREATE ROLE careervine_watcher LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO careervine_watcher;
GRANT EXECUTE ON FUNCTION public.due_send_counts() TO careervine_watcher;

-- Belt and braces: make the absence of table access explicit and durable, so a
-- future blanket `GRANT ... ON ALL TABLES IN SCHEMA public` does not quietly
-- hand this role the queue contents.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM careervine_watcher;
