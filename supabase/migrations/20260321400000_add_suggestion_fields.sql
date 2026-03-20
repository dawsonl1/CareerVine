-- Add columns to follow_up_action_items for AI suggestion metadata
ALTER TABLE follow_up_action_items
  ADD COLUMN source text NOT NULL DEFAULT 'manual',
  ADD COLUMN suggestion_reason_type text,
  ADD COLUMN suggestion_headline text,
  ADD COLUMN suggestion_evidence text;
