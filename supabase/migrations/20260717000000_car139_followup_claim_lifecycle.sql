-- CAR-139: complete the claim lifecycle for follow-up message sends.
-- Mirrors 20260716200000_car134_scheduled_email_claim.sql. 'sending' marks a
-- row claimed by a send driver (already in the status CHECK since
-- 20260712065000_car105_followup_nudge_expiry_columns.sql); claimed_at lets the
-- send-follow-ups cron sweep claims orphaned by a crash mid-send. A stale claim
-- is parked as 'awaiting_review' (user-resolvable via the portal / contact page
-- / nudge emails), never re-queued as 'pending': a crash after the Gmail send
-- but before the mark-sent write is indistinguishable from a crash before the
-- send, and an auto-retry would double-send a real email.

ALTER TABLE email_follow_up_messages ADD COLUMN claimed_at TIMESTAMPTZ;

-- The staleness sweeper scans for old claims each cron tick.
CREATE INDEX idx_follow_up_messages_sending
  ON email_follow_up_messages (claimed_at)
  WHERE status = 'sending';

-- Rows already stranded in 'sending' predate claimed_at. Stamp them now so the
-- first sweep (staleness window after deploy) recovers them instead of leaving
-- them stuck forever.
UPDATE email_follow_up_messages
  SET claimed_at = now()
  WHERE status = 'sending' AND claimed_at IS NULL;

COMMENT ON COLUMN email_follow_up_messages.claimed_at IS
  'CAR-139: when a send driver claimed this row (status=sending). Stale claims are swept to awaiting_review by the send-follow-ups cron.';
