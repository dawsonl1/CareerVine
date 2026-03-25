-- Intro email flow schema changes

-- Add contact_id to email_follow_ups for contact detail page queries
ALTER TABLE email_follow_ups
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_email_follow_ups_contact ON email_follow_ups (contact_id);

-- Allow null thread_id and message_id for scheduled sends (populated when intro actually sends)
ALTER TABLE email_follow_ups ALTER COLUMN original_gmail_message_id DROP NOT NULL;
ALTER TABLE email_follow_ups ALTER COLUMN thread_id DROP NOT NULL;

-- Add 'sending' status for atomic idempotent send (prevents duplicate sends on QStash retries)
ALTER TABLE email_follow_up_messages DROP CONSTRAINT IF EXISTS email_follow_up_messages_status_check;
ALTER TABLE email_follow_up_messages
  ADD CONSTRAINT email_follow_up_messages_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'cancelled'));

-- Add intro_goal to contacts
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intro_goal TEXT;
