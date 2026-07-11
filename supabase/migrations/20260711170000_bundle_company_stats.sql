-- CAR-77: per-company breakdown for a subscribed bundle, so the onboarding
-- company picker can render the moment the user accepts the bundle — before
-- a single contact has been copied. Counts come from bundle_prospects
-- payloads via the CANON-mapped current_company name match (CAR-61 contract:
-- current_company is mapped at publish time to the exact bundle company
-- names, so a case-insensitive name match is exact by construction).
--
-- SECURITY INVOKER on purpose: bundle_companies_select_subscribed and
-- bundle_prospects_select_subscribed already scope both tables to active
-- subscribers, and the picker only renders post-subscribe. Non-subscribers
-- get zero rows, not an error. bundle_companies needs no liveness filter —
-- stale membership rows are hard-deleted at publish finalize (CAR-63).

CREATE FUNCTION bundle_company_stats(p_bundle_id int)
RETURNS TABLE (
  company_id int,
  name text,
  logo_url text,
  prospect_count bigint,
  alumni_count bigint,
  product_alumni_count bigint
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH pros AS (
    SELECT
      lower(btrim(bp.payload->>'current_company')) AS company_key,
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(bp.payload->'education') edu
        WHERE lower(edu->>'school_name') LIKE '%brigham young%'
           OR lower(edu->>'school_name') LIKE 'byu%'
      ) AS is_alum,
      bp.payload->>'persona' IN ('alum_product', 'product_leader', 'product_peer') AS is_product
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND bp.payload->>'current_company' IS NOT NULL
  )
  SELECT
    bc.company_id,
    co.name::text,
    co.logo_url::text,
    count(p.company_key) AS prospect_count,
    count(p.company_key) FILTER (WHERE p.is_alum) AS alumni_count,
    count(p.company_key) FILTER (WHERE p.is_alum AND p.is_product) AS product_alumni_count
  FROM bundle_companies bc
  JOIN companies co ON co.id = bc.company_id
  LEFT JOIN pros p ON p.company_key = lower(btrim(co.name))
  WHERE bc.bundle_id = p_bundle_id
  GROUP BY bc.company_id, co.name, co.logo_url;
$$;

COMMENT ON FUNCTION bundle_company_stats(int) IS 'Per-company prospect/alumni counts for a subscribed bundle, from live bundle_prospects payloads via the CANON current_company name match — CAR-77 onboarding instant company picker. SECURITY INVOKER; subscriber RLS applies.';

REVOKE ALL ON FUNCTION bundle_company_stats(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION bundle_company_stats(int) TO authenticated, service_role;
