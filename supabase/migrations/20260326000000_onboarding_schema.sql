-- Create onboarding tracking table
CREATE TABLE user_onboarding (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  current_step TEXT NOT NULL DEFAULT 'connect_gmail',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  skipped_apollo BOOLEAN DEFAULT false,
  onboarding_calendar_event_id TEXT
);

-- Enable RLS
ALTER TABLE user_onboarding ENABLE ROW LEVEL SECURITY;

-- Users can only read/update their own onboarding row
CREATE POLICY "Users can view own onboarding" ON user_onboarding
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own onboarding" ON user_onboarding
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role can insert (used during signup seed)
CREATE POLICY "Service can insert onboarding" ON user_onboarding
  FOR INSERT WITH CHECK (true);

-- Add is_simulated flag to email_messages for fake replies
ALTER TABLE email_messages ADD COLUMN is_simulated BOOLEAN DEFAULT false;
