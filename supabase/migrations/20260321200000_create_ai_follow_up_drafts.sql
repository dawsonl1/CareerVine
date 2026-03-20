-- AI Follow-Up Drafts: stores AI-generated follow-up email drafts
-- that are surfaced on the dashboard for user review and one-click send.

CREATE TABLE ai_follow_up_drafts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- The draft email
  recipient_email VARCHAR,
  subject         VARCHAR NOT NULL,
  body_html       TEXT NOT NULL CHECK (length(body_html) < 50000),

  -- Thread reply option (null = new email only, populated = user can choose)
  reply_thread_id       VARCHAR,
  reply_thread_subject  VARCHAR,
  send_as_reply         BOOLEAN NOT NULL DEFAULT false,

  -- AI reasoning (transparency for the user)
  extracted_topic TEXT NOT NULL,
  topic_evidence  TEXT NOT NULL,
  source_meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  article_url     VARCHAR,
  article_title   VARCHAR,
  article_source  VARCHAR,

  -- Status
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'dismissed', 'edited_and_sent')),

  -- Tracking
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ
);

-- Only one pending draft per contact per user
CREATE UNIQUE INDEX idx_one_pending_draft_per_contact
  ON ai_follow_up_drafts (user_id, contact_id)
  WHERE status = 'pending';

-- Fast lookup for dashboard: pending drafts per user
CREATE INDEX idx_ai_follow_up_drafts_pending
  ON ai_follow_up_drafts (user_id, status)
  WHERE status = 'pending';

-- RLS
ALTER TABLE ai_follow_up_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own drafts"
  ON ai_follow_up_drafts FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own drafts"
  ON ai_follow_up_drafts FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own drafts"
  ON ai_follow_up_drafts FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own drafts"
  ON ai_follow_up_drafts FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access to ai_follow_up_drafts"
  ON ai_follow_up_drafts FOR ALL
  USING (auth.role() = 'service_role');
