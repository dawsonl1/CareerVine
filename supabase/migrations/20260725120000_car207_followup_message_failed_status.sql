-- CAR-207: give email_follow_up_messages a terminal 'failed' status, mirroring
-- scheduled_emails (20260716200000_car134_scheduled_email_claim.sql).
--
-- Why: a send driver claims a row as 'sending', calls Gmail, then writes
-- 'sent'. When the send SUCCEEDS but the mark-sent write does not, the row is
-- left in 'sending' and the stale-claim sweeper parked it as 'awaiting_review'
-- (CAR-139). That state's entire UI affordance is a one-click "Send now",
-- presented as "this has not been sent yet" — so a message the contact had
-- already received was offered for sending again, and one click delivered it
-- twice.
--
-- CAR-139 was right that the row must never be re-QUEUED automatically, because
-- a crash after the send is indistinguishable from a crash before it. The gap
-- was that it then chose a state which invites the user to do the resend by
-- hand. 'failed' is the honest resting place for that ambiguity: terminal, not
-- actionable, and surfaced as "may already have been sent" rather than as a
-- pending step. scheduled_emails has resolved the identical race this way since
-- CAR-134.
--
-- Additive only. No existing row changes status, and 'failed' is deliberately
-- absent from the OPEN / UNRESOLVED / ACTIONABLE vocabularies in constants.ts,
-- so it holds no parent sequence open, draws no nudge email, and offers no
-- send button.

ALTER TABLE public.email_follow_up_messages
  DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check;

ALTER TABLE public.email_follow_up_messages
  ADD CONSTRAINT email_follow_up_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'awaiting_review', 'expired', 'failed'));

COMMENT ON COLUMN public.email_follow_up_messages.status IS
  'CAR-207: ''failed'' is terminal and means a send driver died between the Gmail send and the mark-sent write, so delivery is UNKNOWN. Never auto-retried and never one-click sendable — an automatic or invited retry could double-send a real email.';
