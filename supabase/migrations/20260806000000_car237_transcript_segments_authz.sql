-- CAR-237: close the transcript_segments authorization hole.
--
-- `replace_transcript_segments` was SECURITY DEFINER with EXECUTE granted to
-- `authenticated` and no check that p_meeting_id belongs to the caller. Definer
-- rights bypass RLS, so any signed-in user could delete and replace another
-- user's transcript segments by passing an arbitrary meeting id. The browser
-- calls this RPC directly (src/lib/data/meetings.ts createTranscriptSegments),
-- so the meeting id is fully caller-controlled.
--
-- Fix: drop SECURITY DEFINER. The function only touches transcript_segments,
-- which already carries owner-scoped RLS on all four commands, so invoker
-- rights make RLS the enforcement rather than bolting a second check on top.
--
-- Why not an explicit `user_id = auth.uid()` guard: the transcribe route calls
-- this RPC with the SERVICE client (src/app/api/transcripts/transcribe/route.ts),
-- where auth.uid() is NULL. A uid guard would reject that legitimate caller.
-- Under invoker rights service_role keeps working via BYPASSRLS, and an
-- authenticated caller is constrained by policy. Both paths stay correct with
-- one mechanism.
--
-- Behavior for a foreign meeting id after this change: the DELETE matches zero
-- rows (policy-filtered, so no data loss) and the INSERT raises a row-level
-- security violation. Loud, and non-destructive.

CREATE OR REPLACE FUNCTION replace_transcript_segments(
  p_meeting_id INTEGER,
  p_segments JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Delete existing segments (RLS-filtered to meetings the caller owns)
  DELETE FROM transcript_segments WHERE meeting_id = p_meeting_id;

  -- Insert new segments from JSON array (RLS WITH CHECK enforces ownership)
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

-- Grants unchanged from 20260321100000 (restated because CREATE OR REPLACE on a
-- function does not reset its ACL, but an explicit restatement keeps the
-- intended end state readable in one place).
REVOKE ALL ON FUNCTION replace_transcript_segments FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_transcript_segments TO authenticated;

-- ── RLS policy repair ──────────────────────────────────────────────────────
-- segments_update had USING but no WITH CHECK, so an UPDATE could move a row to
-- a meeting_id the caller does not own (USING gates which rows are visible to
-- update; WITH CHECK gates what they may become). Restated with both.
--
-- All four are also wrapped as (select auth.uid()) here — the CAR-78 initplan
-- pass (20260711160000) covered the bundle-sync hot paths and missed these.
-- Predicates are otherwise identical to 20260321000000.

DROP POLICY IF EXISTS "segments_select" ON transcript_segments;
CREATE POLICY "segments_select" ON transcript_segments FOR SELECT
  USING (meeting_id IN (SELECT id FROM meetings WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "segments_insert" ON transcript_segments;
CREATE POLICY "segments_insert" ON transcript_segments FOR INSERT
  WITH CHECK (meeting_id IN (SELECT id FROM meetings WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "segments_update" ON transcript_segments;
CREATE POLICY "segments_update" ON transcript_segments FOR UPDATE
  USING (meeting_id IN (SELECT id FROM meetings WHERE user_id = (select auth.uid())))
  WITH CHECK (meeting_id IN (SELECT id FROM meetings WHERE user_id = (select auth.uid())));

DROP POLICY IF EXISTS "segments_delete" ON transcript_segments;
CREATE POLICY "segments_delete" ON transcript_segments FOR DELETE
  USING (meeting_id IN (SELECT id FROM meetings WHERE user_id = (select auth.uid())));
