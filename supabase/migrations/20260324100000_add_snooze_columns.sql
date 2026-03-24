-- Snooze support for action items
ALTER TABLE follow_up_action_items ADD COLUMN IF NOT EXISTS snoozed_until timestamptz DEFAULT NULL;

-- Snooze support for contacts (reach out + recently added)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS reach_out_snoozed_until timestamptz DEFAULT NULL;

-- Skip first outreach (permanently hide from Recently Added and never-contacted Reach Out)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_outreach_skipped boolean NOT NULL DEFAULT false;

-- AI suggestion cooldown (3-week suppression after snooze or dismiss)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS suggestion_cooldown_until timestamptz DEFAULT NULL;
