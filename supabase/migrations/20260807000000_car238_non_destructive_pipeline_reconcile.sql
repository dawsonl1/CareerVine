-- CAR-238: make save_pipeline_cycle stop deleting rows the saving client never saw.
--
-- Every child collection reconciled by delete-not-in:
--
--   DELETE FROM pipeline_notes
--   WHERE cycle_id = v_cycle_id
--     AND id NOT IN (SELECT ... FROM jsonb_array_elements(p_payload->'notes') ...);
--
-- "Not in my payload" was being treated as "deleted", but it also describes every
-- row written by anyone else since this client loaded. Two browser tabs already
-- wipe each other's notes this way, and CAR-238 moves MCP company notes onto the
-- same table, which would make an agent-written note disappear on the user's very
-- next keystroke.
--
-- Fix: deletions become explicit. `p_payload->'deleted'` carries the ids this
-- client actually removed, per collection. Anything absent from the payload but
-- not named in `deleted` is left alone.
--
-- Backward compatible on purpose: a client that sends no `deleted` key deletes
-- nothing. The old callers therefore become non-destructive rather than broken,
-- which is the safe direction to fail while the client rolls out.
--
-- Applies to ALL FOUR collections, not just notes. They share one delete-not-in
-- shape, so fixing notes alone would leave the identical hole open beside it.

CREATE OR REPLACE FUNCTION "public"."save_pipeline_cycle"(
  "p_target_company_id" integer,
  "p_cycle_number" integer,
  "p_payload" "jsonb"
) RETURNS integer
    LANGUAGE "plpgsql"
    SET search_path = public, pg_temp
    AS $$
DECLARE
  v_cycle_id int;
  v_deleted jsonb := COALESCE(p_payload->'deleted', '{}'::jsonb);
BEGIN
  INSERT INTO pipeline_cycles (target_company_id, cycle_number, selected_stage, declined_next_cycle, updated_at)
  VALUES (
    p_target_company_id,
    p_cycle_number,
    COALESCE(p_payload->>'selected_stage', 'researching'),
    COALESCE((p_payload->>'declined_next_cycle')::boolean, false),
    now()
  )
  ON CONFLICT (target_company_id, cycle_number) DO UPDATE SET
    selected_stage = EXCLUDED.selected_stage,
    declined_next_cycle = EXCLUDED.declined_next_cycle,
    updated_at = now()
  RETURNING id INTO v_cycle_id;

  -- programs
  DELETE FROM pipeline_programs
  WHERE cycle_id = v_cycle_id
    AND id IN (SELECT (e#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(v_deleted->'programs', '[]'::jsonb)) e);
  INSERT INTO pipeline_programs (id, cycle_id, name, apps_open, job_potential, position)
  SELECT (e->>'id')::uuid, v_cycle_id,
         COALESCE(e->>'name', ''), COALESCE(e->>'apps_open', ''), COALESCE(e->>'job_potential', ''),
         ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'programs', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, apps_open = EXCLUDED.apps_open,
    job_potential = EXCLUDED.job_potential, position = EXCLUDED.position;

  -- notes
  DELETE FROM pipeline_notes
  WHERE cycle_id = v_cycle_id
    AND id IN (SELECT (e#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(v_deleted->'notes', '[]'::jsonb)) e);
  INSERT INTO pipeline_notes (id, cycle_id, body, position)
  SELECT (e->>'id')::uuid, v_cycle_id, COALESCE(e->>'body', ''), ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'notes', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, position = EXCLUDED.position;

  -- applications
  DELETE FROM pipeline_applications
  WHERE cycle_id = v_cycle_id
    AND id IN (SELECT (e#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(v_deleted->'applications', '[]'::jsonb)) e);
  INSERT INTO pipeline_applications (
    id, cycle_id, job_title, location, date_applied,
    resume_path, resume_name, resume_size_bytes,
    cover_letter_path, cover_letter_name, cover_letter_size_bytes, position
  )
  SELECT (e->>'id')::uuid, v_cycle_id,
         COALESCE(e->>'job_title', ''), COALESCE(e->>'location', ''),
         NULLIF(e->>'date_applied', '')::date,
         e->>'resume_path', e->>'resume_name', (e->>'resume_size_bytes')::int,
         e->>'cover_letter_path', e->>'cover_letter_name', (e->>'cover_letter_size_bytes')::int,
         ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'applications', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET
    job_title = EXCLUDED.job_title, location = EXCLUDED.location,
    date_applied = EXCLUDED.date_applied,
    resume_path = EXCLUDED.resume_path, resume_name = EXCLUDED.resume_name,
    resume_size_bytes = EXCLUDED.resume_size_bytes,
    cover_letter_path = EXCLUDED.cover_letter_path, cover_letter_name = EXCLUDED.cover_letter_name,
    cover_letter_size_bytes = EXCLUDED.cover_letter_size_bytes,
    position = EXCLUDED.position;

  -- interview rounds
  DELETE FROM pipeline_interview_rounds
  WHERE cycle_id = v_cycle_id
    AND id IN (SELECT (e#>>'{}')::uuid FROM jsonb_array_elements(COALESCE(v_deleted->'interview_rounds', '[]'::jsonb)) e);
  INSERT INTO pipeline_interview_rounds (id, cycle_id, interview_date, interviewer, questions, position)
  SELECT (e->>'id')::uuid, v_cycle_id,
         NULLIF(e->>'interview_date', '')::date,
         COALESCE(e->>'interviewer', ''), COALESCE(e->>'questions', ''),
         ord - 1
  FROM jsonb_array_elements(COALESCE(p_payload->'interview_rounds', '[]'::jsonb)) WITH ORDINALITY AS t(e, ord)
  ON CONFLICT (id) DO UPDATE SET
    interview_date = EXCLUDED.interview_date, interviewer = EXCLUDED.interviewer,
    questions = EXCLUDED.questions, position = EXCLUDED.position;

  RETURN v_cycle_id;
END;
$$;
