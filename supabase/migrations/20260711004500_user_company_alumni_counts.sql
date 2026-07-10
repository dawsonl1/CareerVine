-- CAR-50: the onboarding company picker ranks the user's companies by how
-- many BYU alumni they hold. Deriving this client-side would mean shipping
-- every contact's education rows to the browser, so aggregate in SQL.
--
-- SECURITY INVOKER (default): runs as the calling user, so contacts /
-- contact_companies / contact_schools RLS applies — the explicit
-- auth.uid() filter is intent, RLS is the guarantee.
--
-- School matching mirrors isByuSchoolName() in company-queries.ts.
CREATE OR REPLACE FUNCTION user_company_alumni_counts()
RETURNS TABLE (company_id int, alumni_count bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT cc.company_id, count(DISTINCT c.id) AS alumni_count
  FROM contact_companies cc
  JOIN contacts c ON c.id = cc.contact_id AND c.user_id = auth.uid()
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

COMMENT ON FUNCTION user_company_alumni_counts() IS 'Per-company count of the calling user''s BYU-alumni contacts with current employment there (CAR-50 onboarding picker). SECURITY INVOKER — RLS applies.';

REVOKE ALL ON FUNCTION user_company_alumni_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION user_company_alumni_counts() TO authenticated, service_role;
