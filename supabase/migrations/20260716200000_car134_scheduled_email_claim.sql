-- CAR-134: atomic claim step for scheduled-email sends.
-- 'sending' marks a row claimed by a send driver (cron or page-load process);
-- 'failed' marks a claim that went stale (process died mid-send). Stale claims
-- are flagged, never auto-retried: a crash after the Gmail send but before the
-- mark-sent write is indistinguishable from a crash before the send, and
-- auto-retry would double-send a real email.
ALTER TABLE scheduled_emails DROP CONSTRAINT scheduled_emails_status_check;
ALTER TABLE scheduled_emails ADD CONSTRAINT scheduled_emails_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed'));

ALTER TABLE scheduled_emails ADD COLUMN claimed_at TIMESTAMPTZ;

-- The staleness sweeper scans for old claims each cron tick.
CREATE INDEX idx_scheduled_emails_sending
  ON scheduled_emails (claimed_at)
  WHERE status = 'sending';
