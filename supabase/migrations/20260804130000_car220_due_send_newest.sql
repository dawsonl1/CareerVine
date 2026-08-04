-- CAR-220: give the watcher a progress signal a stuck row cannot pin.
--
-- ── The defect ──────────────────────────────────────────────────────────
--
-- `RouteState` decides "this backlog will not drain, back off" by comparing the
-- due COUNT against the count at its last trigger. That is sound only while the
-- baseline is zero. It is not sound once a row exists that is permanently
-- due-but-unsendable, and such rows are real: a bounced recipient leaves a
-- scheduled email pending indefinitely, and a user at their daily cap leaves
-- theirs pending until tomorrow.
--
-- With a poison row present, any window in which one row drains and another
-- arrives nets to an unchanged count, reads as "no progress", and holds the
-- watcher on its 900s cooldown. A behavioural simulation of the real loop put a
-- healthy user's mail 400s late, with the worst case bounded only by
-- STUCK_MAX_SECONDS — i.e. one user's bounced address taxing every other user
-- with exactly the latency this whole feature was built to remove.
--
-- ── Why NEWEST and not oldest ───────────────────────────────────────────
--
-- The obvious addition is the oldest due instant, and it does not work: the
-- poison row IS the oldest, so it pins that value just as hard as it pins the
-- count. The newest due instant moves whenever fresh work arrives, which is the
-- thing the watcher actually needs to notice, and it is unaffected by a stale
-- row sitting behind it.
--
-- The function's return type changes, so this is DROP + CREATE rather than
-- CREATE OR REPLACE. That discards the ACL, so the CAR-220 lockdown is
-- reapplied below: without it the function would silently return to Supabase's
-- default `authenticated` grant, which is the exact hole
-- 20260804120000_car220_due_send_counts_lockdown.sql closed.

DROP FUNCTION IF EXISTS public.due_send_counts();

CREATE FUNCTION public.due_send_counts()
RETURNS TABLE (
  scheduled_due bigint,
  follow_ups_due bigint,
  -- NULL when the queue is empty; the watcher treats that as "no work".
  scheduled_newest timestamptz,
  follow_ups_newest timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH s AS (
    SELECT se.scheduled_send_at
      FROM scheduled_emails se
      JOIN users u ON u.id = se.user_id
     WHERE se.status = 'pending'
       AND se.scheduled_send_at <= now()
       AND u.status = 'active'
  ), f AS (
    SELECT m.scheduled_send_at
      FROM email_follow_up_messages m
      JOIN email_follow_ups fu ON fu.id = m.follow_up_id
      JOIN users u ON u.id = fu.user_id
     WHERE m.status = 'pending'
       AND m.scheduled_send_at <= now()
       AND fu.status = 'active'
       AND fu.thread_id IS NOT NULL
       AND u.status = 'active'
  )
  SELECT
    (SELECT count(*) FROM s),
    (SELECT count(*) FROM f),
    (SELECT max(scheduled_send_at) FROM s),
    (SELECT max(scheduled_send_at) FROM f);
$$;

COMMENT ON FUNCTION public.due_send_counts() IS
  'CAR-215/CAR-220: how many scheduled emails / follow-up steps are due right now, and the newest due instant in each queue, mirroring the send crons'' own due conditions. The watcher uses (count, newest) as its progress signal: a count alone is pinned by a permanently-undeliverable row, which stalls delivery for unrelated users. EXECUTE is careervine_watcher only — REVOKE FROM PUBLIC does not remove Supabase''s default authenticated grant, so any new revoke must name the roles explicitly.';

-- Reapply the CAR-220 lockdown, since DROP took the ACL with it.
REVOKE ALL ON FUNCTION public.due_send_counts()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.due_send_counts() TO careervine_watcher;
