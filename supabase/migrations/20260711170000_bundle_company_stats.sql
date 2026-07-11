-- CAR-77: per-company stats for a bundle, computed from bundle-level data so
-- the onboarding company picker can render the moment the user subscribes —
-- before a single contact has synced. Same technique as bundle_alumni_stats
-- (CAR-61): the payload's current_company is CANON-mapped to the bundle
-- company names at pipeline time, so a case-insensitive name match against
-- companies.name is exact by construction.
--
-- SECURITY INVOKER on purpose: bundle_prospects and bundle_companies are only
-- readable with an active subscription + visibility (their RLS policies), so
-- a non-subscriber calling this gets zero rows — no new exposure surface.
CREATE OR REPLACE FUNCTION bundle_company_stats(p_bundle_id int)
RETURNS TABLE (
  company_id int,
  name text,
  logo_url text,
  prospect_count bigint,
  alumni_count bigint,
  product_alumni_count bigint
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH live AS (
    SELECT
      lower(btrim(bp.payload->>'current_company')) AS cname,
      EXISTS (
        -- Mirrors isByuSchoolName() (company-queries.ts) and CAR-61's stats:
        -- contains "brigham young" or starts with "byu", case-insensitive.
        SELECT 1 FROM jsonb_array_elements(bp.payload->'education') edu
        WHERE lower(edu->>'school_name') LIKE '%brigham young%'
           OR lower(edu->>'school_name') LIKE 'byu%'
      ) AS is_alum,
      bp.payload->>'persona' IN ('alum_product', 'product_leader', 'product_peer') AS is_product
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND bp.payload->>'current_company' IS NOT NULL
  ),
  stats AS (
    SELECT
      live.cname,
      count(*) AS prospect_count,
      count(*) FILTER (WHERE live.is_alum) AS alumni_count,
      count(*) FILTER (WHERE live.is_alum AND live.is_product) AS product_alumni_count
    FROM live
    GROUP BY live.cname
  )
  SELECT
    co.id,
    co.name,
    co.logo_url,
    COALESCE(s.prospect_count, 0),
    COALESCE(s.alumni_count, 0),
    COALESCE(s.product_alumni_count, 0)
  FROM bundle_companies bc
  JOIN companies co ON co.id = bc.company_id
  LEFT JOIN stats s ON s.cname = lower(btrim(co.name))
  WHERE bc.bundle_id = p_bundle_id;
$$;

COMMENT ON FUNCTION bundle_company_stats(int) IS 'Per-company prospect/BYU-alumni/product-role counts for a bundle, from bundle-level data (CAR-77 onboarding picker). SECURITY INVOKER; subscriber-only RLS on the underlying tables applies.';

REVOKE ALL ON FUNCTION bundle_company_stats(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION bundle_company_stats(int) TO authenticated, service_role;
