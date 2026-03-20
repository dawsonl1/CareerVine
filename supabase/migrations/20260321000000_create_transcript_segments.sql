-- Create transcript_segments table for structured, speaker-attributed transcript storage
CREATE TABLE transcript_segments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  speaker_label TEXT NOT NULL,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  started_at  REAL,
  ended_at    REAL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE transcript_segments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "segments_select" ON transcript_segments FOR SELECT
  USING (meeting_id IN (SELECT id FROM meetings WHERE user_id = auth.uid()));
CREATE POLICY "segments_insert" ON transcript_segments FOR INSERT
  WITH CHECK (meeting_id IN (SELECT id FROM meetings WHERE user_id = auth.uid()));
CREATE POLICY "segments_update" ON transcript_segments FOR UPDATE
  USING (meeting_id IN (SELECT id FROM meetings WHERE user_id = auth.uid()));
CREATE POLICY "segments_delete" ON transcript_segments FOR DELETE
  USING (meeting_id IN (SELECT id FROM meetings WHERE user_id = auth.uid()));

CREATE INDEX idx_transcript_segments_meeting ON transcript_segments(meeting_id, ordinal);

-- Add transcript metadata columns to meetings
ALTER TABLE meetings ADD COLUMN transcript_source TEXT;
ALTER TABLE meetings ADD COLUMN transcript_parsed BOOLEAN DEFAULT FALSE;
ALTER TABLE meetings ADD COLUMN transcript_attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL;
