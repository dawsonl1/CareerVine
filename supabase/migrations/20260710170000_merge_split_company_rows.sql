-- ═══════════════════════════════════════════════════════════════════
-- CAR-44: merge hand-named, identity-less company rows into the
-- LinkedIn-identified siblings that actually hold the scraped contacts.
--
-- The target-list import created companies from hand-written names with no
-- linkedin_company_id; the Apify scrape import resolved employers by
-- LinkedIn identity onto separate rows. These pairs share NO identity key,
-- so the 20260708113000 identity-based dedup can never merge them — the
-- pair list below is explicit and human-verified against production
-- (2026-07-10), guarded by id+name so it no-ops on environments where the
-- data doesn't match (fresh/dev databases).
--
-- Differences from the 20260708113000 pattern, all deliberate:
--  * Survivor is the identity-bearing row per pair, NOT MIN(id) — the
--    hand-named loser is usually older.
--  * contact_companies/user_companies use collide-then-update, because
--    UNIQUE(contact_id|user_id, company_id, start_date) makes a blind
--    UPDATE unsafe (the old migration's "no uniqueness conflict" comment
--    was wrong).
--  * target_companies merges per (user_id, company_id, location_id) —
--    the old ON CONFLICT (user_id, company_id) arbiter no longer exists
--    (replaced by two partial indexes in 20260710070000).
--  * pipeline_cycles / target_company_notes are repointed BEFORE loser
--    target_companies rows are deleted (both cascade off target_companies).
--  * bundle_companies / discovery_candidates / scrape_runs postdate the
--    old migration and are handled here.
--
-- Also adds companies.name_normalized (generated) so findOrCreateCompany
-- can match name variants ("Rubrik" vs "Rubrik, Inc.") and stop minting
-- these splits — see normalizeCompanyName() in company-helpers.ts, which
-- MUST stay in sync with the SQL expression below.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. Normalized company name: matching support for the resolver ────
-- lowercase → every non-alphanumeric run becomes one space → trim →
-- strip trailing legal-suffix tokens. Conservative by design: "Zoom" and
-- "Zoom Video Communications" deliberately do NOT normalize together.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS name_normalized text
  GENERATED ALWAYS AS (
    regexp_replace(
      btrim(regexp_replace(lower(name), '[^a-z0-9]+', ' ', 'g')),
      '( (inc|incorporated|llc|llp|ltd|limited|corp|corporation|co|company|lp|plc|gmbh|pllc))+$',
      ''
    )
  ) STORED;

COMMENT ON COLUMN companies.name_normalized IS
  'Normalized matching key (case/punctuation/legal-suffix-insensitive). Expression must stay in sync with normalizeCompanyName() in careervine/src/lib/company-helpers.ts';

CREATE INDEX IF NOT EXISTS companies_name_normalized_idx
  ON companies (name_normalized);

-- ── 1. Verified merge pairs ──────────────────────────────────────────
-- new_name = post-merge display name for the survivor (NULL = keep).

CREATE TEMP TABLE pair (
  loser_id int PRIMARY KEY,
  loser_name text NOT NULL,
  survivor_id int NOT NULL,
  survivor_name text NOT NULL,
  new_name text
) ON COMMIT DROP;

INSERT INTO pair (loser_id, loser_name, survivor_id, survivor_name, new_name) VALUES
  -- APM Data Bundle pairs (the 8 zero-contact bundle companies)
  (297,  'Hewlett Packard Enterprise (HPE)',    574,  'Hewlett-Packard',               'Hewlett Packard Enterprise'),
  (60,   'HealthTree Foundation',               3419, 'HealthTree',                    'HealthTree Foundation'),
  (215,  'Western Governors University (WGU)',  4967, 'Western Governors University',  NULL),
  (344,  'Signals',                             956,  'Atonom',                        NULL),
  (222,  'Lucid Software',                      1437, 'Lucid Software Inc.',           'Lucid Software'),
  (273,  'Dell Technologies',                   573,  'Dell',                          'Dell Technologies'),
  (325,  'NiCE',                                6497, 'NICE inContact',                NULL),
  (7598, 'Zynga (RPM/APM program)',             163,  'Zynga',                         NULL),
  -- High-confidence non-bundle pairs
  (209,  'Instructure (Canvas LMS)',            740,  'Instructure, Inc.',             'Instructure'),
  (359,  'Traeger',                             3211, 'Traeger Pellet Grills, LLC',    'Traeger'),
  (357,  'Xactware / Verisk',                   1618, 'Xactware',                      NULL),
  (250,  'SalesRabbit',                         2364, 'Sales Rabbit, Inc.',            'SalesRabbit'),
  (459,  'Rubrik',                              4679, 'Rubrik, Inc.',                  'Rubrik'),
  (277,  'Bloomberg',                           1026, 'Bloomberg LP',                  'Bloomberg'),
  (232,  'doTERRA International',               1172, 'doTERRA International LLC',     'doTERRA International'),
  (300,  'Overstock.com (Beyond, Inc.)',        571,  'Overstock.com',                 NULL),
  (363,  'Franklin Covey',                      3028, 'FranklinCovey',                 NULL),
  (203,  'Zoom',                                3314, 'Zoom Video Communications',     'Zoom'),
  (246,  'Merit Medical Systems',               1286, 'Merit Medical Systems, Inc.',   'Merit Medical Systems'),
  (199,  'X (Twitter)',                         1180, 'Twitter',                       NULL),
  (263,  'Reddit',                              7195, 'Reddit, Inc.',                  'Reddit'),
  (251,  'Digital Harbor, Inc.',                6095, 'Digital Harbor',                NULL),
  (360,  'Backcountry',                         1666, 'Backcountry.com',               'Backcountry'),
  (372,  'Angel Studios',                       3439, 'Angel',                         'Angel Studios'),
  (219,  'Veras',                               1224, 'Veras (Formerly Jobwise)',      'Veras'),
  (224,  'Bed Bath & Beyond (Utah digital HQ)', 2177, 'Bed Bath & Beyond',             NULL),
  -- Judgment pairs, approved by Dawson 2026-07-10: acquisition/parent rows —
  -- the scrape covered the parent, so the target re-points at the scraped row.
  (405,  'Verifi (Visa)',                       154,  'Visa',                          NULL),
  (465,  'Duo Security (Cisco)',                723,  'Cisco',                         NULL),
  (390,  'Vizio (Walmart)',                     161,  'Walmart',                       NULL),
  (424,  'Buildium (RealPage)',                 5776, 'RealPage, Inc.',                'RealPage'),
  (193,  'TikTok / ByteDance',                  854,  'ByteDance',                     NULL),
  (236,  'BioFire / bioMérieux',                1092, 'bioMérieux',                    NULL),
  (296,  'Amazon / AWS',                        61,   'Amazon',                        NULL);
  -- Deliberately NOT merged (reviewed and rejected): Warner Bros. Discovery /
  -- Warner Music Group (genuinely different entities), Amazon Web Services
  -- (id 68, distinct row that keeps its own contacts), HP (id 847).

-- Environment guard: keep only pairs whose ids AND names both match, so a
-- dev/reset database (or drifted prod row) skips cleanly instead of merging
-- the wrong companies.
DELETE FROM pair p
WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.loser_id AND c.name = p.loser_name)
   OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = p.survivor_id AND c.name = p.survivor_name);

DO $$
DECLARE active int;
BEGIN
  SELECT COUNT(*) INTO active FROM pair;
  RAISE NOTICE 'CAR-44 company merge: % of 33 verified pairs matched this environment', active;
END $$;

-- ── 2. contact_companies — UNIQUE(contact_id, company_id, start_date) ─
-- Drop loser employment rows that would collide with an existing survivor
-- row, then repoint the rest.

DELETE FROM contact_companies cc
USING pair p
WHERE cc.company_id = p.loser_id
  AND EXISTS (
    SELECT 1 FROM contact_companies s
    WHERE s.contact_id = cc.contact_id
      AND s.company_id = p.survivor_id
      AND s.start_date IS NOT DISTINCT FROM cc.start_date
  );

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

UPDATE user_companies uc
SET company_id = p.survivor_id
FROM pair p
WHERE uc.company_id = p.loser_id;

-- ── 4. company_locations — UNIQUE(company_id, location_id) ───────────

INSERT INTO company_locations (company_id, location_id, source, created_at)
SELECT p.survivor_id, cl.location_id, cl.source, cl.created_at
FROM company_locations cl
JOIN pair p ON p.loser_id = cl.company_id
ON CONFLICT (company_id, location_id) DO NOTHING;

DELETE FROM company_locations cl
USING pair p
WHERE cl.company_id = p.loser_id;

-- ── 5. bundle_companies — UNIQUE(bundle_id, company_id) ──────────────

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
--       discovery runs. A queued loser run that duplicates a queued
--       survivor run has no spend/results yet — drop it, repoint the rest.

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

UPDATE scrape_runs sr
SET company_id = p.survivor_id
FROM pair p
WHERE sr.company_id = p.loser_id;

-- ── 8. target_companies — merge per (user_id, company_id, location_id) ─
-- Where the same user already targets the survivor at the same scope,
-- merge the loser row's fields into it and repoint children; otherwise a
-- plain company_id repoint is collision-free under both partial indexes.

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
    tier             = COALESCE(st.tier, lt.tier),
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

-- Children first: both cascade off target_companies, so the loser rows'
-- notes and pipeline data must move before the DELETE below.
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

-- Remaining loser rows have no survivor-scope twin: plain repoint.
UPDATE target_companies tc
SET company_id = p.survivor_id
FROM pair p
WHERE tc.company_id = p.loser_id;

-- ── 9. Delete the loser company rows (all FKs repointed above) ───────

DELETE FROM companies c
USING pair p
WHERE c.id = p.loser_id;

-- ── 10. Survivor display names (companies.name is UNIQUE — only safe
--        now that the losers are gone; skip on any residual collision) ─

UPDATE companies c
SET name = p.new_name
FROM pair p
WHERE c.id = p.survivor_id
  AND p.new_name IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM companies x WHERE x.name = p.new_name AND x.id <> p.survivor_id);

-- ── 11. bundle_companies is denormalized into data_bundles.company_count ─

UPDATE data_bundles b
SET company_count = sub.cnt
FROM (SELECT bundle_id, COUNT(*) AS cnt FROM bundle_companies GROUP BY bundle_id) sub
WHERE sub.bundle_id = b.id
  AND b.company_count <> sub.cnt;

-- ── 12. Assertions ────────────────────────────────────────────────────

DO $$
DECLARE bad int;
BEGIN
  SELECT COUNT(*) INTO bad FROM companies c JOIN pair p ON p.loser_id = c.id;
  IF bad > 0 THEN
    RAISE EXCEPTION 'CAR-44 merge: % loser company rows survived the merge', bad;
  END IF;

  -- Every merged survivor that sits in a bundle must now show contacts —
  -- the defect this migration exists to fix.
  SELECT COUNT(*) INTO bad
  FROM pair p
  JOIN bundle_companies bc ON bc.company_id = p.survivor_id
  WHERE NOT EXISTS (SELECT 1 FROM contact_companies cc WHERE cc.company_id = p.survivor_id);
  IF bad > 0 THEN
    RAISE EXCEPTION 'CAR-44 merge: % merged bundle companies still have zero contacts', bad;
  END IF;
END $$;

COMMIT;
