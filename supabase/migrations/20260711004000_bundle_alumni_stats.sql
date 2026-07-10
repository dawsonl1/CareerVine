-- CAR-50: live stats for the onboarding progress modal. The modal's numbers
-- ("N prospects… N BYU alumni… across N companies") must be computed from the
-- published bundle, never hardcoded — they drift on every republish.
--
-- Alumni facts live inside bundle_prospects.payload (jsonb education arrays),
-- which RLS hides until the user subscribes. The offer modal needs the numbers
-- BEFORE subscribing, so this runs SECURITY DEFINER but (a) gates on the same
-- bundle_visible_to() + published check as the browse policy and (b) returns
-- only aggregate counts — no payload content can leak.
--
-- School matching mirrors isByuSchoolName() in company-queries.ts:
-- contains "brigham young" or starts with "byu", case-insensitive.
CREATE OR REPLACE FUNCTION bundle_alumni_stats(p_bundle_id int)
RETURNS TABLE (alumni_count bigint, alumni_company_count bigint)
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
    (SELECT count(DISTINCT lower(exp->'company'->>'name'))
       FROM alum, jsonb_array_elements(alum.payload->'experiences') exp
      WHERE (exp->>'is_current')::boolean
        AND exp->'company'->>'name' IS NOT NULL) AS alumni_company_count;
$$;

COMMENT ON FUNCTION bundle_alumni_stats(int) IS 'Aggregate BYU-alumni counts for a published, visible bundle (CAR-50 onboarding stats). SECURITY DEFINER with the browse-visibility gate inlined; exposes counts only.';

REVOKE ALL ON FUNCTION bundle_alumni_stats(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION bundle_alumni_stats(int) TO authenticated, service_role;
