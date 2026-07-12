-- CAR-105 Phase A: follow-up nudge + expiry anchors, and the 'expired' status.
--
-- CAR-102 parks a due free-tier follow-up as 'awaiting_review' with NO timestamp,
-- so there is no anchor for a countdown, expiry, or nudge cadence. CAR-105 adds:
--   parked_at          — when the message became awaiting_review (the anchor P).
--   expires_at         — the active-aware expiry deadline (initially P + 14 days;
--                        the nudge cron may push it out once in the grace branch).
--   reminder_count     — how many milestone emails have been sent (0..3: day 0/4/9);
--                        also the idempotency cursor for the daily digest.
--   last_reminder_at   — when the last milestone email went out (dedupe within a day).
--   seen_during_window — set true by the nudge cron when the user was active in-app
--                        during [parked_at, parked_at+14d]; drives active-aware expiry.
--
-- 'expired' status: a message whose expiry elapsed WITHOUT being actioned. It is NOT
-- cancelled/deleted — it stays visible (greyed) and one-click sendable. The parent
-- sequence stays 'active' (expiry is per-message), so every "still open" count and
-- teardown-cancel must treat 'expired' as open (see UNRESOLVED_FOLLOW_UP_MESSAGE_STATUSES
-- in constants.ts). The status CHECK is a NAMED constraint, so drop + re-add (the
-- established pattern: 20260325000000_intro_email_flow.sql, 20260712040000_car102...).

ALTER TABLE public.email_follow_up_messages
  ADD COLUMN IF NOT EXISTS parked_at timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz,
  ADD COLUMN IF NOT EXISTS seen_during_window boolean NOT NULL DEFAULT false;

ALTER TABLE public.email_follow_up_messages
  DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check;

ALTER TABLE public.email_follow_up_messages
  ADD CONSTRAINT email_follow_up_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'awaiting_review', 'expired'));

-- Backfill any rows already parked by CAR-102 before this migration. Anchor P to
-- the best available proxy (scheduled_send_at ≈ when it fell due and was parked,
-- else created_at) and set the 14-day deadline. reminder_count = 3 suppresses
-- retroactive day 0/4/9 emails for pre-feature items — they still get the countdown
-- and expiry, just no surprise back-dated nudges. Near-moot today (CAR-102 just
-- shipped) but correct if any awaiting_review rows exist.
UPDATE public.email_follow_up_messages
  SET parked_at = COALESCE(scheduled_send_at, created_at),
      expires_at = COALESCE(scheduled_send_at, created_at) + interval '14 days',
      reminder_count = 3
  WHERE status = 'awaiting_review' AND parked_at IS NULL;

COMMENT ON COLUMN public.email_follow_up_messages.parked_at IS
  'CAR-105: when the message became awaiting_review (anchor P for countdown/expiry/nudges).';
COMMENT ON COLUMN public.email_follow_up_messages.expires_at IS
  'CAR-105: active-aware expiry deadline. Initially parked_at + 14d; the nudge cron pushes it out once (to next-visit + 24h) if the user was never active during the window.';
COMMENT ON COLUMN public.email_follow_up_messages.reminder_count IS
  'CAR-105: milestone emails sent (0..3 = day 0/4/9). Also the daily-digest idempotency cursor.';
COMMENT ON COLUMN public.email_follow_up_messages.seen_during_window IS
  'CAR-105: set true by the nudge cron when the user was active in-app during [parked_at, parked_at+14d]; gates the active-aware expiry branch.';
