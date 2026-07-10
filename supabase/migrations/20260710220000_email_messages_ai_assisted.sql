-- CAR-58 analytics audit: reply_received.ai_assisted was never populated
-- because nothing recorded whether an outbound message was AI-drafted.
-- Sends now stamp this at cache time (email-send.ts); reply attribution
-- reads it per thread to emit reply_received { ai_assisted }.
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS ai_assisted boolean NOT NULL DEFAULT false;
