-- Atomic replace of transcript segments for a meeting.
-- Deletes existing segments and inserts new ones in a single transaction,
-- preventing data loss if the insert fails.
CREATE OR REPLACE FUNCTION replace_transcript_segments(
  p_meeting_id INTEGER,
  p_segments JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete existing segments
  DELETE FROM transcript_segments WHERE meeting_id = p_meeting_id;

  -- Insert new segments from JSON array
  INSERT INTO transcript_segments (meeting_id, ordinal, speaker_label, contact_id, started_at, ended_at, content)
  SELECT
    p_meeting_id,
    (elem->>'ordinal')::INTEGER,
    elem->>'speaker_label',
    NULLIF(elem->>'contact_id', '')::INTEGER,
    NULLIF(elem->>'started_at', '')::REAL,
    NULLIF(elem->>'ended_at', '')::REAL,
    elem->>'content'
  FROM jsonb_array_elements(p_segments) AS elem;
END;
$$;

-- Restrict to authenticated users only
REVOKE ALL ON FUNCTION replace_transcript_segments FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_transcript_segments TO authenticated;
