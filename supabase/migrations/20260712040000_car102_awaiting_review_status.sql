-- CAR-102 Phase C: add the awaiting_review follow-up message status.
--
-- Free-tier follow-ups are confirm-to-send: the send-follow-ups cron flips a due
-- message to 'awaiting_review' (instead of auto-sending) and the user confirms it
-- from the Outreach portal (which also captures reply status). The status CHECK is
-- a NAMED constraint, so it must be dropped and re-added -- you cannot extend a
-- CHECK in place. Existing values (pending/sending/sent/cancelled) are preserved.

ALTER TABLE public.email_follow_up_messages
  DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check;

ALTER TABLE public.email_follow_up_messages
  ADD CONSTRAINT email_follow_up_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'awaiting_review'));
