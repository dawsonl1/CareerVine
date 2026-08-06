-- CAR-238: move existing MCP-written company notes into the visible Notes list.
--
-- `add_company_intel` used to write `target_company_notes`, which the company
-- page renders only as a fallback block. Every such note written before this
-- change is sitting in the database invisible behind the user's own notes.
--
-- Copy each one into `pipeline_notes` on its target's active cycle, appended
-- after whatever is already there.
--
-- The source rows are deliberately LEFT IN PLACE rather than deleted:
--   - re-running this migration would otherwise be the only way to lose them,
--   - the UI now renders any residual `target_company_notes` unconditionally,
--     so a row that somehow escapes this copy is still visible rather than
--     silently buried, which was the whole defect.
-- Deleting them can be a follow-up once the copy is confirmed in production.
--
-- Idempotent: a second run inserts nothing, because it skips any source note
-- whose exact body already exists on the destination cycle.

DO $$
DECLARE
  r RECORD;
  v_cycle_id int;
  v_position int;
  v_copied int := 0;
BEGIN
  FOR r IN
    SELECT n.id, n.note, n.target_company_id, COALESCE(t.active_cycle, 1) AS cycle_number
    FROM target_company_notes n
    JOIN target_companies t ON t.id = n.target_company_id
    ORDER BY n.target_company_id, n.created_at, n.id
  LOOP
    -- The cycle row may not exist on a company whose pipeline was never opened.
    INSERT INTO pipeline_cycles (target_company_id, cycle_number)
    VALUES (r.target_company_id, r.cycle_number)
    ON CONFLICT (target_company_id, cycle_number) DO UPDATE
      SET cycle_number = EXCLUDED.cycle_number
    RETURNING id INTO v_cycle_id;

    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pipeline_notes p WHERE p.cycle_id = v_cycle_id AND p.body = r.note
    );

    SELECT COALESCE(MAX(position), -1) + 1 INTO v_position
    FROM pipeline_notes WHERE cycle_id = v_cycle_id;

    INSERT INTO pipeline_notes (id, cycle_id, body, position)
    VALUES (gen_random_uuid(), v_cycle_id, r.note, v_position);

    v_copied := v_copied + 1;
  END LOOP;

  RAISE NOTICE 'CAR-238 backfill: copied % intel note(s) into pipeline_notes', v_copied;
END
$$;
