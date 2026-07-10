-- CAR-61: the CAR-50 stats were dishonest in two ways —
--   1. "alumni in product roles" counted ALL alumni (persona never reached
--      the payload, so role filtering was impossible);
--   2. the company stat counted every distinct employer in alumni work
--      histories (~1,079) instead of "how many of the bundle's companies
--      have an alum there today" (≤ the bundle's company count).
-- The payload contract now carries `persona` (pipeline-verified) and
-- `current_company` (CANON-mapped employer name that matches the bundle
-- company list by construction). Recreate both stats functions on top.
-- Return shapes change, so DROP + CREATE (CREATE OR REPLACE can't alter
-- OUT parameters).
--
-- Product roles = persona IN (alum_product, product_leader, product_peer);
-- alum_other and recruiter are alumni but not product roles.

DROP FUNCTION IF EXISTS bundle_alumni_stats(int);
CREATE FUNCTION bundle_alumni_stats(p_bundle_id int)
RETURNS TABLE (alumni_count bigint, alumni_product_count bigint, alumni_company_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH alum AS (
    SELECT bp.payload
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND EXISTS (
        SELECT 1 FROM data_bundles db
        WHERE db.id = p_bundle_id
          AND db.status = 'published'
          AND bundle_visible_to(db.id, auth.uid())
      )
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(bp.payload->'education') edu
        WHERE lower(edu->>'school_name') LIKE '%brigham young%'
           OR lower(edu->>'school_name') LIKE 'byu%'
      )
  )
  SELECT
    (SELECT count(*) FROM alum) AS alumni_count,
    (SELECT count(*) FROM alum
      WHERE alum.payload->>'persona' IN ('alum_product', 'product_leader', 'product_peer')
    ) AS alumni_product_count,
    -- "N of the bundle's companies have a BYU alum there today": the
    -- payload's current_company is CANON-mapped to the same names as the
    -- bundle company list, so a case-insensitive name match is exact by
    -- construction (raw experience employer names would NOT be).
    (SELECT count(DISTINCT co.id)
       FROM bundle_companies bc
       JOIN companies co ON co.id = bc.company_id
      WHERE bc.bundle_id = p_bundle_id
        AND lower(btrim(co.name)) IN (
          SELECT lower(btrim(a.payload->>'current_company'))
          FROM alum a
          WHERE a.payload->>'current_company' IS NOT NULL
        )
    ) AS alumni_company_count;
$$;

COMMENT ON FUNCTION bundle_alumni_stats(int) IS 'Aggregate BYU-alumni counts (total, product-role, bundle companies with a current alum) for a published, visible bundle — CAR-50/CAR-61 onboarding stats. SECURITY DEFINER with the browse-visibility gate inlined; exposes counts only.';

REVOKE ALL ON FUNCTION bundle_alumni_stats(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION bundle_alumni_stats(int) TO authenticated, service_role;

DROP FUNCTION IF EXISTS user_company_alumni_counts();
CREATE FUNCTION user_company_alumni_counts()
RETURNS TABLE (company_id int, alumni_count bigint, product_alumni_count bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT
    cc.company_id,
    count(DISTINCT c.id) AS alumni_count,
    count(DISTINCT c.id) FILTER (
      WHERE c.persona IN ('alum_product', 'product_leader', 'product_peer')
    ) AS product_alumni_count
  FROM contact_companies cc
  JOIN contacts c ON c.id = cc.contact_id
    AND c.user_id = auth.uid()
    -- Bench is excluded everywhere "current contacts" are counted.
    AND c.network_status <> 'bench'
  WHERE cc.is_current
    AND EXISTS (
      SELECT 1
      FROM contact_schools cs
      JOIN schools s ON s.id = cs.school_id
      WHERE cs.contact_id = c.id
        AND (lower(s.name) LIKE '%brigham young%' OR lower(s.name) LIKE 'byu%')
    )
  GROUP BY cc.company_id;
$$;

COMMENT ON FUNCTION user_company_alumni_counts() IS 'Per-company counts of the calling user''s current BYU-alumni contacts — total and product-role (persona-based) — for the CAR-50 onboarding picker. SECURITY INVOKER; RLS applies.';

REVOKE ALL ON FUNCTION user_company_alumni_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION user_company_alumni_counts() TO authenticated, service_role;
