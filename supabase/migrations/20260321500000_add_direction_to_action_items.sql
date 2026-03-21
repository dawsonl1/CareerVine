-- Add ownership direction and speaker tracking to action items
-- Enables "waiting on" tracking and linked commitment pairing

ALTER TABLE follow_up_action_items
  ADD COLUMN direction text DEFAULT 'my_task'
    CHECK (direction IN ('my_task', 'waiting_on', 'mutual')),
  ADD COLUMN assigned_speaker text,
  ADD COLUMN related_action_item_id integer REFERENCES follow_up_action_items(id) ON DELETE SET NULL;
