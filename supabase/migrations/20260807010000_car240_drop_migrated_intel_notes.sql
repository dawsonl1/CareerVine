-- CAR-240: drop the target_company_notes rows CAR-238 already copied into
-- pipeline_notes.
--
-- CAR-238 deliberately left the sources in place so the copy could be verified
-- in production before anything was destroyed. It has been (1 row, target 186,
-- 1,653 chars, matching body present).
--
-- GUARDED: a row is deleted only when a pipeline note with the identical body
-- exists on the same target. Anything unmigrated survives, and the UI renders
-- residual rows unconditionally since CAR-238, so a survivor stays visible
-- rather than silently buried. Idempotent, and a no-op on a fresh database.
--
-- The TABLE is kept. `add_company_intel` no longer writes to it, but dropping
-- it would also drop the read path that keeps an unmigrated row visible.

DO $$
DECLARE
  v_deleted int;
  v_left int;
BEGIN
  DELETE FROM target_company_notes n
  WHERE EXISTS (
    SELECT 1
    FROM pipeline_notes p
    JOIN pipeline_cycles c ON c.id = p.cycle_id
    WHERE c.target_company_id = n.target_company_id
      AND p.body = n.note
  );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT count(*) INTO v_left FROM target_company_notes;
  RAISE NOTICE 'CAR-240: deleted % migrated intel note(s); % row(s) remain (unmigrated, still rendered)', v_deleted, v_left;
END
$$;
