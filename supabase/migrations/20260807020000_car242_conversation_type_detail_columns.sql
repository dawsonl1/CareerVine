-- CAR-242 (1 of 2) — the EXPAND half: additive only, safe to apply while the
-- previous release is still serving traffic.
--
-- Rule 42 sequencing. The pair of migrations behind CAR-242 cannot ship as one
-- file: this half is purely additive, but its sibling
-- (20260807030000_car242_narrow_conversation_types.sql) adds CHECK constraints
-- that REJECT values the currently-deployed code still writes (`phone`,
-- `video`, `in-person`, `lunch`, `conference`). Applying the constraints before
-- the new build is live would 23514 every meeting logged in that window.
--
--   apply THIS file  ->  merge + deploy  ->  apply the CONTRACT half
--
-- Everything here is invisible to the old code: it selects neither new column,
-- and text/varchar are interchangeable over PostgREST.

-- varchar → text. NOT cosmetic. On a varchar column Postgres renders an IN
-- constraint as `((col)::text = ANY (...))`, but the CHECK-conformance guard
-- (src/__integration__/check-constraints.itest.ts) matches on the literal
-- `(col = ANY `. The contract half's CHECKs would be invisible to that guard —
-- silently unverified, the precise gap the suite exists to close (CAR-132,
-- CAR-178). Every other CHECK-guarded column in this schema is already text.
ALTER TABLE meetings     ALTER COLUMN meeting_type     TYPE text;
ALTER TABLE interactions ALTER COLUMN interaction_type TYPE text;

ALTER TABLE meetings     ADD COLUMN IF NOT EXISTS meeting_type_detail     text;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS interaction_type_detail text;

COMMENT ON COLUMN meetings.meeting_type_detail IS
  'Free text the user typed after choosing meeting_type = ''other''. NULL for every other type (CHECK added in 20260807030000).';
COMMENT ON COLUMN interactions.interaction_type_detail IS
  'Free text the user typed after choosing interaction_type = ''other''. NULL for every other type (CHECK added in 20260807030000).';
