-- Merge duplicate companies created by mixed identity matching paths.
-- Target-company import can create name/url-based rows while people import
-- creates id-based rows. This migration consolidates by LinkedIn identity.

BEGIN;

CREATE TEMP TABLE company_merge_map (
  from_id int PRIMARY KEY,
  to_id int NOT NULL
) ON COMMIT DROP;

-- Determine duplicate rows by shared LinkedIn identity keys. Keep the lowest
-- id row as canonical for each key so mapping is acyclic (from_id > to_id).
WITH identity_keys AS (
  SELECT id, linkedin_company_id AS key_value
  FROM companies
  WHERE linkedin_company_id IS NOT NULL AND btrim(linkedin_company_id) <> ''
  UNION ALL
  SELECT id, lower(regexp_replace(btrim(linkedin_url), '/+$', '')) AS key_value
  FROM companies
  WHERE linkedin_url IS NOT NULL AND btrim(linkedin_url) <> ''
  UNION ALL
  SELECT id, lower(btrim(universal_name)) AS key_value
  FROM companies
  WHERE universal_name IS NOT NULL AND btrim(universal_name) <> ''
),
canonical_by_key AS (
  SELECT key_value, MIN(id) AS canonical_id
  FROM identity_keys
  GROUP BY key_value
  HAVING COUNT(*) > 1
),
candidate_map AS (
  SELECT k.id AS from_id, MIN(c.canonical_id) AS to_id
  FROM identity_keys k
  JOIN canonical_by_key c ON c.key_value = k.key_value
  GROUP BY k.id
)
INSERT INTO company_merge_map (from_id, to_id)
SELECT from_id, to_id
FROM candidate_map
WHERE from_id > to_id;

-- contact_companies has no uniqueness conflict on company_id, so direct update.
UPDATE contact_companies cc
SET company_id = m.to_id
FROM company_merge_map m
WHERE cc.company_id = m.from_id;

-- company_locations has UNIQUE(company_id, location_id), so upsert then remove old.
INSERT INTO company_locations (company_id, location_id, source, created_at)
SELECT m.to_id, cl.location_id, cl.source, cl.created_at
FROM company_locations cl
JOIN company_merge_map m ON m.from_id = cl.company_id
ON CONFLICT (company_id, location_id) DO NOTHING;

DELETE FROM company_locations cl
USING company_merge_map m
WHERE cl.company_id = m.from_id;

-- target_companies has UNIQUE(user_id, company_id). Re-insert onto canonical
-- company_id, merge data conservatively, then repoint notes and remove old rows.
CREATE TEMP TABLE target_company_repoint AS
SELECT
  tc.id AS old_target_company_id,
  tc.user_id,
  COALESCE(m.to_id, tc.company_id) AS desired_company_id
FROM target_companies tc
LEFT JOIN company_merge_map m ON m.from_id = tc.company_id;

INSERT INTO target_companies (
  user_id,
  company_id,
  priority_score,
  tier,
  program_name,
  app_window_text,
  next_app_date,
  status,
  created_at,
  updated_at
)
SELECT
  grouped.user_id,
  grouped.desired_company_id,
  grouped.priority_score,
  grouped.tier,
  grouped.program_name,
  grouped.app_window_text,
  grouped.next_app_date,
  grouped.status,
  grouped.created_at,
  grouped.updated_at
FROM (
  SELECT
    tc.user_id,
    tr.desired_company_id,
    MAX(tc.priority_score) AS priority_score,
    MAX(tc.tier) AS tier,
    MAX(tc.program_name) AS program_name,
    MAX(tc.app_window_text) AS app_window_text,
    MAX(tc.next_app_date) AS next_app_date,
    CASE
      WHEN BOOL_OR(tc.status = 'closed') THEN 'closed'
      WHEN BOOL_OR(tc.status = 'interviewing') THEN 'interviewing'
      WHEN BOOL_OR(tc.status = 'applied') THEN 'applied'
      WHEN BOOL_OR(tc.status = 'outreach_active') THEN 'outreach_active'
      ELSE 'researching'
    END AS status,
    MIN(tc.created_at) AS created_at,
    MAX(tc.updated_at) AS updated_at
  FROM target_companies tc
  JOIN target_company_repoint tr ON tr.old_target_company_id = tc.id
  GROUP BY tc.user_id, tr.desired_company_id
) grouped
ON CONFLICT (user_id, company_id) DO UPDATE
SET
  priority_score = COALESCE(target_companies.priority_score, EXCLUDED.priority_score),
  tier = COALESCE(target_companies.tier, EXCLUDED.tier),
  program_name = COALESCE(target_companies.program_name, EXCLUDED.program_name),
  app_window_text = COALESCE(target_companies.app_window_text, EXCLUDED.app_window_text),
  next_app_date = COALESCE(target_companies.next_app_date, EXCLUDED.next_app_date),
  status = CASE
    WHEN target_companies.status = 'researching' AND EXCLUDED.status <> 'researching' THEN EXCLUDED.status
    ELSE target_companies.status
  END,
  updated_at = GREATEST(target_companies.updated_at, EXCLUDED.updated_at);

UPDATE target_company_notes n
SET target_company_id = t_new.id
FROM target_company_repoint tr
JOIN target_companies t_new
  ON t_new.user_id = tr.user_id
 AND t_new.company_id = tr.desired_company_id
WHERE n.target_company_id = tr.old_target_company_id
  AND n.target_company_id <> t_new.id;

DELETE FROM target_companies tc
USING target_company_repoint tr
JOIN target_companies t_keep
  ON t_keep.user_id = tr.user_id
 AND t_keep.company_id = tr.desired_company_id
WHERE tc.id = tr.old_target_company_id
  AND tc.id <> t_keep.id;

-- Finally remove duplicate company rows that were merged.
DELETE FROM companies c
USING company_merge_map m
WHERE c.id = m.from_id;

COMMIT;
