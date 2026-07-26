-- CAR-207 deep review. Two fixes, both found while auditing the follow-up
-- status vocabulary against schema truth (CLAUDE.md rule 40).
--
-- A separate migration from 20260725120000 because that one is already applied
-- to production; editing an applied file leaves the new statements permanently
-- unrun.

-- ── 1. 'cancelled_bounce' has never been a legal status ──────────────────
--
-- A live, pre-existing bug. `detectBounces` in careervine/src/lib/gmail.ts
-- writes `email_follow_ups.status = 'cancelled_bounce'` when a delivery failure
-- is parsed, but the CHECK created in 20260218060000_create_email_follow_ups.sql
-- only ever allowed four values and was never widened. Verified against
-- PRODUCTION rather than inferred from the types file (rule 12/37):
--
--   CHECK ((status = ANY (ARRAY['active','cancelled_reply','cancelled_user','completed'])))
--
-- So every bounce-driven cancel returns 23514. The write is unchecked, so the
-- error is swallowed, the run reports success, and the sequence is left half
-- torn down: its messages are cancelled but the parent stays 'active' forever.
-- Nothing revisits it, because the send cron's due query needs a 'pending'
-- message, and the contact page keeps rendering a live "0 of N sent" sequence.
-- This is CAR-132's shape exactly.
--
-- Why the existing conformance guard missed it: check-constraints.itest.ts
-- enumerates Object.values(FollowUpStatus), and that enum held only 'active'
-- and 'cancelled_user'. The other three were raw string literals, invisible to
-- the test. Adding them to the enum (done alongside this migration) is what
-- makes the guard actually cover this vocabulary from now on.

ALTER TABLE public.email_follow_ups
  DROP CONSTRAINT IF EXISTS email_follow_ups_status_check;

ALTER TABLE public.email_follow_ups
  ADD CONSTRAINT email_follow_ups_status_check
  CHECK (status IN ('active', 'cancelled_reply', 'cancelled_user', 'completed', 'cancelled_bounce'));

COMMENT ON COLUMN public.email_follow_ups.status IS
  'CAR-207: ''cancelled_bounce'' is written by detectBounces when a delivery failure retires the sequence. It was absent from this CHECK from the table''s creation until now, so every bounce cancel silently failed with 23514.';

-- Repair the rows that bug stranded: a sequence still 'active' whose every
-- message is resolved is exactly the half-torn-down state above, and nothing in
-- the app can ever move it again. Scoped to sequences with no unresolved
-- message AND at least one message, so a freshly created sequence awaiting its
-- first row is untouched.
UPDATE public.email_follow_ups f
   SET status = 'completed',
       updated_at = now()
 WHERE f.status = 'active'
   AND EXISTS (SELECT 1 FROM public.email_follow_up_messages m WHERE m.follow_up_id = f.id)
   AND NOT EXISTS (
     SELECT 1 FROM public.email_follow_up_messages m
      WHERE m.follow_up_id = f.id
        AND m.status IN ('pending', 'sending', 'awaiting_review', 'expired')
   );

-- ── 2. A column comment that now contradicts the code ────────────────────
--
-- 20260717000000_car139_followup_claim_lifecycle.sql documented stale claims as
-- being swept to 'awaiting_review'. As of 20260725120000 they are swept to
-- 'failed', and a comment that disagrees with the code is how the next person
-- reintroduces the double-send.

COMMENT ON COLUMN public.email_follow_up_messages.claimed_at IS
  'CAR-139: when a send driver claimed this row (status=sending). Stale claims are swept to ''failed'' by the send-follow-ups cron (CAR-207; previously ''awaiting_review'', which offered a one-click resend of a possibly-delivered message).';

-- No backfill of existing 'awaiting_review' rows. Some could in principle have
-- come from the OLD sweeper rather than the free-tier confirm-to-send path, and
-- those would still be re-sendable. Checked against production before deciding:
-- all such rows belong to connections with modify_scope_granted = false, which
-- cannot resolve `followups:auto` (capabilitiesFor requires modifyScopeGranted
-- AND premiumEnabled), so the tier-park arm is the only thing that could have
-- written them. Nothing to migrate. Recorded so the question reads as answered
-- rather than unasked.
