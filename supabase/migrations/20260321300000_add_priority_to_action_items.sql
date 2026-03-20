ALTER TABLE follow_up_action_items
  ADD COLUMN priority TEXT DEFAULT NULL
  CHECK (priority IN ('high', 'medium', 'low'));
