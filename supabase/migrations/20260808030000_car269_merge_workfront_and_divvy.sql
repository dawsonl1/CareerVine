-- ═══════════════════════════════════════════════════════════════════
-- CAR-269: consolidate Adobe/Workfront and BILL/Divvy into single rows.
--
-- Both splits are acquisition-shaped: LinkedIn keeps a separate company page
-- for the acquired brand (Workfront 48453, Divvy 10593835 "divvynowbill"), so
-- identity-based dedup can never unify them with the parent (Adobe 1480,
-- BILL 113254). Dawson's ruling: they ARE the parent. The resolver-side fix
-- ships in the same PR (applyCompanyConsolidations in company-helpers.ts) so
-- no import path re-mints these rows; this migration merges what exists.
--
-- Verified against production 2026-08-07:
--   211  'Adobe (Workfront office)'  → 166 'Adobe'    (125 employment rows)
--   7619 'Workfront' (identity-less) → 166 'Adobe'    (2 rows)
--   701  'Divvy | Inc.'              → 249 'Divvy'    (125 rows)
-- and 249 — which already holds BILL's LinkedIn identity (113254,
-- /company/bill) but wears Divvy's name — is renamed 'BILL (Bill.com)'.
--
-- Pattern follows 20260710170000_merge_split_company_rows.sql, with three
-- deliberate differences:
--  * contact_companies collide-then-repoint keys on the CAR-261 natural key
--    (contact_id, company_id, title, start_month, end_month) NULLS NOT
--    DISTINCT — the template's start_date key predates 20260808020000 and is
--    obsolete.
--  * Two losers share the Adobe survivor, so every collide pass gets a
--    cross-loser dedupe (rank among loser rows landing on the same survivor
--    key) the pairwise template never needed.
--  * bundle_prospects.resolved snapshots (CAR-62) embed experiences[].
--    company_id by VALUE, and bundle-fast-apply.ts inserts those ids into
--    contact_companies verbatim — a deleted loser id there would FK-fail
--    every blank-subscriber sync. The snapshots are rewritten in the same
--    transaction, preserving payload_hash so they stay hash-current.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Verified merge pairs (id+name environment guard) ──────────────

CREATE TEMP TABLE pair (
  loser_id int PRIMARY KEY,
  loser_name text NOT NULL,
  survivor_id int NOT NULL,
  survivor_name text NOT NULL,
  new_name text
) ON COMMIT DROP;

INSERT INTO pair (loser_id, loser_name, survivor_id, survivor_name, new_name) VALUES
  (211,  'Adobe (Workfront office)', 166, 'Adobe', NULL),
  (7619, 'Workfront',                166, 'Adobe', NULL),
  (701,  'Divvy | Inc.',             249, 'Divvy', 'BILL (Bill.com)');

DELETE FROM pair p
WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.loser_id AND c.name = p.loser_name)
   OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.survivor_id AND c.name = p.survivor_name);

DO $$
DECLARE active int;
BEGIN
  SELECT COUNT(*) INTO active FROM pair;
  RAISE NOTICE 'CAR-269 company merge: % of 3 verified pairs matched this environment', active;
END $$;

-- ── 2. contact_companies — UNIQUE(contact_id, company_id, title,
--       start_month, end_month) NULLS NOT DISTINCT (CAR-261) ──────────
-- Drop loser rows that would collide with an existing survivor row, then
-- collapse cross-loser twins (211 and 7619 both land on 166), then repoint.

DELETE FROM contact_companies cc
USING pair p
WHERE cc.company_id = p.loser_id
  AND EXISTS (
    SELECT 1 FROM contact_companies s
    WHERE s.contact_id = cc.contact_id
      AND s.company_id = p.survivor_id
      AND s.title IS NOT DISTINCT FROM cc.title
      AND s.start_month IS NOT DISTINCT FROM cc.start_month
      AND s.end_month IS NOT DISTINCT FROM cc.end_month
  );

WITH ranked AS (
  SELECT cc.id,
         row_number() OVER (
           PARTITION BY p.survivor_id, cc.contact_id, cc.title, cc.start_month, cc.end_month
           ORDER BY cc.id
         ) AS rn
  FROM contact_companies cc
  JOIN pair p ON p.loser_id = cc.company_id
)
DELETE FROM contact_companies cc
USING ranked r
WHERE cc.id = r.id AND r.rn > 1;

UPDATE contact_companies cc
SET company_id = p.survivor_id
FROM pair p
WHERE cc.company_id = p.loser_id;

-- ── 3. user_companies — UNIQUE(user_id, company_id, start_date) ──────

DELETE FROM user_companies uc
USING pair p
WHERE uc.company_id = p.loser_id
  AND EXISTS (
    SELECT 1 FROM user_companies s
    WHERE s.user_id = uc.user_id
      AND s.company_id = p.survivor_id
      AND s.start_date IS NOT DISTINCT FROM uc.start_date
  );

WITH ranked AS (
  SELECT uc.id,
         row_number() OVER (
           PARTITION BY p.survivor_id, uc.user_id, uc.start_date
           ORDER BY uc.id
         ) AS rn
  FROM user_companies uc
  JOIN pair p ON p.loser_id = uc.company_id
)
DELETE FROM user_companies uc
USING ranked r
WHERE uc.id = r.id AND r.rn > 1;

UPDATE user_companies uc
SET company_id = p.survivor_id
FROM pair p
WHERE uc.company_id = p.loser_id;

-- ── 4. company_locations — UNIQUE(company_id, location_id) ───────────
-- ON CONFLICT DO NOTHING also absorbs intra-statement twins from the two
-- Adobe losers carrying the same location.

INSERT INTO company_locations (company_id, location_id, source, created_at)
SELECT p.survivor_id, cl.location_id, cl.source, cl.created_at
FROM company_locations cl
JOIN pair p ON p.loser_id = cl.company_id
ON CONFLICT (company_id, location_id) DO NOTHING;

DELETE FROM company_locations cl
USING pair p
WHERE cl.company_id = p.loser_id;

-- ── 5. bundle_companies — UNIQUE(bundle_id, company_id) ──────────────
-- Bundle 1 currently lists BOTH 166 and 211: the loser membership just
-- disappears into the survivor's.

INSERT INTO bundle_companies (bundle_id, company_id, created_at)
SELECT bc.bundle_id, p.survivor_id, bc.created_at
FROM bundle_companies bc
JOIN pair p ON p.loser_id = bc.company_id
ON CONFLICT (bundle_id, company_id) DO NOTHING;

DELETE FROM bundle_companies bc
USING pair p
WHERE bc.company_id = p.loser_id;

-- ── 6. discovery_candidates — unique key is (user_id, linkedin_url) ──

UPDATE discovery_candidates dc
SET company_id = p.survivor_id
FROM pair p
WHERE dc.company_id = p.loser_id;

-- ── 7. scrape_runs — partial UNIQUE(user_id, company_id) on queued
--       discovery runs; a queued loser twin has no spend yet — drop it. ─

DELETE FROM scrape_runs sr
USING pair p
WHERE sr.company_id = p.loser_id
  AND sr.status = 'pending' AND sr.mode = 'discovery'
  AND EXISTS (
    SELECT 1 FROM scrape_runs s
    WHERE s.user_id = sr.user_id
      AND s.company_id = p.survivor_id
      AND s.status = 'pending' AND s.mode = 'discovery'
  );

WITH ranked AS (
  SELECT sr.id,
         row_number() OVER (PARTITION BY p.survivor_id, sr.user_id ORDER BY sr.id) AS rn
  FROM scrape_runs sr
  JOIN pair p ON p.loser_id = sr.company_id
  WHERE sr.status = 'pending' AND sr.mode = 'discovery'
)
DELETE FROM scrape_runs sr
USING ranked r
WHERE sr.id = r.id AND r.rn > 1;

UPDATE scrape_runs sr
SET company_id = p.survivor_id
FROM pair p
WHERE sr.company_id = p.loser_id;

-- ── 8. target_companies — merge per (user_id, company_id, location_id) ─
-- Same-scope survivor twins absorb the loser row's fields; children
-- (notes, pipeline_cycles) move before the loser rows are deleted.

CREATE TEMP TABLE tc_map ON COMMIT DROP AS
SELECT lt.id AS loser_tc_id, st.id AS survivor_tc_id
FROM target_companies lt
JOIN pair p ON p.loser_id = lt.company_id
JOIN target_companies st
  ON st.user_id = lt.user_id
 AND st.company_id = p.survivor_id
 AND st.location_id IS NOT DISTINCT FROM lt.location_id;

UPDATE target_companies st
SET priority_score   = COALESCE(st.priority_score, lt.priority_score),
    program_name     = COALESCE(st.program_name, lt.program_name),
    app_window_text  = COALESCE(st.app_window_text, lt.app_window_text),
    next_app_date    = COALESCE(st.next_app_date, lt.next_app_date),
    status           = CASE
                         WHEN 'closed'          IN (st.status, lt.status) THEN 'closed'
                         WHEN 'interviewing'    IN (st.status, lt.status) THEN 'interviewing'
                         WHEN 'applied'         IN (st.status, lt.status) THEN 'applied'
                         WHEN 'outreach_active' IN (st.status, lt.status) THEN 'outreach_active'
                         ELSE 'researching'
                       END,
    is_targeted      = st.is_targeted OR lt.is_targeted,
    last_discovery_at = GREATEST(st.last_discovery_at, lt.last_discovery_at),
    created_at       = LEAST(st.created_at, lt.created_at),
    updated_at       = GREATEST(st.updated_at, lt.updated_at)
FROM tc_map m
JOIN target_companies lt ON lt.id = m.loser_tc_id
WHERE st.id = m.survivor_tc_id;

UPDATE target_company_notes n
SET target_company_id = m.survivor_tc_id
FROM tc_map m
WHERE n.target_company_id = m.loser_tc_id;

-- pipeline_cycles has UNIQUE(target_company_id, cycle_number): shift the
-- loser's cycle numbers past the survivor's so both histories survive.
UPDATE pipeline_cycles pc
SET target_company_id = m.survivor_tc_id,
    cycle_number = pc.cycle_number + COALESCE(
      (SELECT MAX(x.cycle_number) FROM pipeline_cycles x WHERE x.target_company_id = m.survivor_tc_id), 0)
FROM tc_map m
WHERE pc.target_company_id = m.loser_tc_id;

DELETE FROM target_companies tc
USING tc_map m
WHERE tc.id = m.loser_tc_id;

-- Cross-loser twins destined for the same survivor scope: keep the oldest,
-- move its children, drop the rest.
CREATE TEMP TABLE tc_xloser ON COMMIT DROP AS
SELECT tc.id AS drop_tc_id,
       first_value(tc.id) OVER w AS keep_tc_id
FROM target_companies tc
JOIN pair p ON p.loser_id = tc.company_id
WINDOW w AS (
  PARTITION BY p.survivor_id, tc.user_id, tc.location_id
  ORDER BY tc.id
  ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
);
DELETE FROM tc_xloser WHERE drop_tc_id = keep_tc_id;

UPDATE target_company_notes n
SET target_company_id = x.keep_tc_id
FROM tc_xloser x
WHERE n.target_company_id = x.drop_tc_id;

UPDATE pipeline_cycles pc
SET target_company_id = x.keep_tc_id,
    cycle_number = pc.cycle_number + COALESCE(
      (SELECT MAX(y.cycle_number) FROM pipeline_cycles y WHERE y.target_company_id = x.keep_tc_id), 0)
FROM tc_xloser x
WHERE pc.target_company_id = x.drop_tc_id;

DELETE FROM target_companies tc
USING tc_xloser x
WHERE tc.id = x.drop_tc_id;

-- Remaining loser rows are collision-free under both partial indexes.
UPDATE target_companies tc
SET company_id = p.survivor_id
FROM pair p
WHERE tc.company_id = p.loser_id;

-- ── 9. bundle_prospects.resolved — publish-time snapshots (CAR-62) ───
-- experiences[].company_id is stored by value and consumed verbatim by
-- bundle-fast-apply; rewrite loser ids in place. jsonb_set preserves
-- payload_hash, so rewritten resolutions stay hash-current. A single
-- snapshot can reference more than one loser, hence the per-element
-- LEFT JOIN rather than an UPDATE ... FROM pair join.

UPDATE bundle_prospects bp
SET resolved = jsonb_set(
  bp.resolved,
  '{experiences}',
  (
    SELECT jsonb_agg(
             CASE WHEN p.survivor_id IS NOT NULL
                  THEN jsonb_set(t.e, '{company_id}', to_jsonb(p.survivor_id))
                  ELSE t.e
             END
             ORDER BY t.ord)
    FROM jsonb_array_elements(bp.resolved->'experiences') WITH ORDINALITY AS t(e, ord)
    LEFT JOIN pair p
      ON t.e->>'company_id' ~ '^[0-9]+$'
     AND p.loser_id = (t.e->>'company_id')::int
  )
)
WHERE bp.resolved IS NOT NULL
  AND jsonb_typeof(bp.resolved->'experiences') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(bp.resolved->'experiences') AS e
    JOIN pair p ON e->>'company_id' ~ '^[0-9]+$'
              AND p.loser_id = (e->>'company_id')::int
  );

-- ── 10. Delete the loser company rows (all FKs repointed above) ──────

DELETE FROM companies c
USING pair p
WHERE c.id = p.loser_id;

-- ── 11. Survivor display names (companies.name is UNIQUE — only safe
--        now that the losers are gone; skip on any residual collision) ─

UPDATE companies c
SET name = p.new_name
FROM pair p
WHERE c.id = p.survivor_id
  AND p.new_name IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM companies x WHERE x.name = p.new_name AND x.id <> p.survivor_id);

-- ── 12. bundle_companies is denormalized into data_bundles.company_count ─

UPDATE data_bundles b
SET company_count = sub.cnt
FROM (SELECT bundle_id, COUNT(*) AS cnt FROM bundle_companies GROUP BY bundle_id) sub
WHERE sub.bundle_id = b.id
  AND b.company_count <> sub.cnt;

-- ── 13. Assertions ────────────────────────────────────────────────────

DO $$
DECLARE bad int;
BEGIN
  SELECT COUNT(*) INTO bad FROM companies c JOIN pair p ON p.loser_id = c.id;
  IF bad > 0 THEN
    RAISE EXCEPTION 'CAR-269 merge: % loser company rows survived the merge', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM bundle_prospects bp
  WHERE bp.resolved IS NOT NULL
    AND jsonb_typeof(bp.resolved->'experiences') = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(bp.resolved->'experiences') AS e
      JOIN pair p ON e->>'company_id' ~ '^[0-9]+$'
                AND p.loser_id = (e->>'company_id')::int
    );
  IF bad > 0 THEN
    RAISE EXCEPTION 'CAR-269 merge: % resolved snapshots still reference a merged-away company', bad;
  END IF;
END $$;

COMMIT;
