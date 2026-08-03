-- CAR-213: one SQL statement of the school rule, and the two raw facts the
-- bundle filter and stats need denormalized onto bundle_prospects.
--
-- Before this, the BYU test was copy-pasted in FIVE places: two TS helpers plus
-- three inline predicates in bundle_alumni_stats, bundle_company_stats, and
-- user_company_alumni_counts — each with a comment claiming it "mirrors" one of
-- the others. There is now one TS implementation
-- (careervine/src/lib/schools/affinity.ts) and one SQL implementation here,
-- held together by a parity test that runs a SHARED fixture through both
-- against real Postgres (src/__integration__/school-affinity-parity.itest.ts).
-- Change the rule in one place and that test tells you about the other.

-- ── 1. Normalization, byte-for-byte with normalizeSchoolName() in TS ──
-- Periods strip BEFORE the non-alphanumeric pass, so "B.Y.U." collapses to the
-- single token "byu" rather than to three separate letters, which no match on
-- "byu" could then catch. Order here is load-bearing; the parity test pins it.
CREATE OR REPLACE FUNCTION public.normalize_school_name(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT regexp_replace(
           btrim(
             regexp_replace(replace(lower(p_name), '.', ''), '[^a-z0-9]+', ' ', 'g')
           ),
           '^the ', ''
         )
$$;

COMMENT ON FUNCTION public.normalize_school_name(text) IS
  'Canonical school-name form (CAR-213). MUST match normalizeSchoolName() in careervine/src/lib/schools/affinity.ts; the parity itest enforces it.';

-- ── 2. The rule ───────────────────────────────────────────────────────
-- `\ybyu` is Postgres''s word boundary followed by byu, mirroring /\bbyu/ in
-- TS: boundary before, deliberately none after. A falsification pass showed
-- neither obvious alternative works alone — a prefix test misses "Marriott
-- School at BYU", a both-sides boundary misses "BYUIdaho" typed without a
-- separator. Still rejects "Bryant University" (b-r-y), "Young Harris College"
-- (has "young", not "brigham young"), and "Utah Valley University" (huge BYU
-- overlap in real life, entirely separate alumni network).
CREATE OR REPLACE FUNCTION public.is_byu_family_school(p_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_name IS NULL THEN false
    ELSE public.normalize_school_name(p_name) LIKE '%brigham young%'
      OR public.normalize_school_name(p_name) ~ '\ybyu'
  END
$$;

COMMENT ON FUNCTION public.is_byu_family_school(text) IS
  'BYU-family school test (CAR-213). MUST match isByuFamilySchool() in careervine/src/lib/schools/affinity.ts; the parity itest enforces it.';

-- ── 2b. The exclusion rule, stated once ───────────────────────────────
-- Mirrors isAlumniOnlyProspect() in affinity.ts. A function rather than an
-- inline predicate for the same reason is_byu_family_school() is one: the
-- first draft of this migration inlined it in two stats functions, which is
-- how the codebase acquired five copies of the BYU test in the first place.
--
-- The SEMANTIC rule ships, not `persona = 'alum_other'`. Against the live
-- bundle those select the identical 888 rows, but that equivalence is a
-- property of today's data, and a publish carrying a new persona must not
-- silently start dropping people.
--
-- FAILS SAFE on a NULL persona: an unclassified prospect is KEPT. Dropping
-- withholds a real person from a user's database, so it is the destructive
-- direction, and an unknown value must never be the reason for it.
CREATE OR REPLACE FUNCTION public.is_alumni_only_prospect(p_is_alumni boolean, p_persona text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT COALESCE(p_is_alumni, false)
     AND p_persona IS NOT NULL
     AND p_persona NOT IN ('alum_product', 'product_leader', 'product_peer', 'recruiter')
$$;

COMMENT ON FUNCTION public.is_alumni_only_prospect(boolean, text) IS
  'True when a bundle prospect is present ONLY for the alumni angle, so a subscriber with no alumni affinity does not receive them (CAR-213). MUST match isAlumniOnlyProspect() in careervine/src/lib/schools/affinity.ts; the parity itest enforces it.';

-- ── 3. Denormalize the two raw facts onto bundle_prospects ────────────
-- Raw facts only. Deliberately NOT an `alumni_only` column: that is derivable
-- from these two, and a derived-from-derived column would be a second copy of
-- the product rule, free to rot independently of the first.
ALTER TABLE bundle_prospects ADD COLUMN IF NOT EXISTS is_alumni boolean NOT NULL DEFAULT false;
ALTER TABLE bundle_prospects ADD COLUMN IF NOT EXISTS persona text;

COMMENT ON COLUMN bundle_prospects.is_alumni IS
  'Payload education contains a BYU-family school (CAR-213). Written at publish; publish is the only writer and always rewrites the payload, so it cannot drift.';
COMMENT ON COLUMN bundle_prospects.persona IS
  'Denormalized payload->>persona (CAR-213). Lets the filter and the stats functions stop re-walking jsonb on every call.';

-- Backfill. Note this uses the NEW normalizer, which is slightly more
-- permissive than the LIKE patterns it replaces (it also catches "B.Y.U.",
-- "BYUIdaho", and mid-string BYU). That is the intended correction, so a small
-- number of prospects may flip to is_alumni = true here versus what the old
-- stats reported.
UPDATE bundle_prospects
SET is_alumni = EXISTS (
      SELECT 1
      FROM jsonb_array_elements(payload -> 'education') edu
      WHERE public.is_byu_family_school(edu ->> 'school_name')
    ),
    persona = payload ->> 'persona';

CREATE INDEX IF NOT EXISTS bundle_prospects_bundle_alumni_idx
  ON bundle_prospects (bundle_id, is_alumni);

-- ── 4. Repoint the three stats functions at the shared rule ───────────
-- Same return shapes and same semantics as before; the only changes are that
-- the inline LIKE predicates become is_byu_family_school() and the jsonb
-- persona/education walks become column reads.
-- Gains eligible_prospect_count: the BUNDLE-WIDE number of prospects a
-- subscriber with no alumni affinity actually receives.
--
-- This cannot come from bundle_company_stats. That function only counts
-- prospects whose current employer IS one of the bundle's companies — against
-- the live bundle it sums to 1,145 of 2,000 (653 eligible), because the rest
-- work somewhere off the target list. Feeding those per-company sums to the
-- progress bar would stall it at 59% just as surely as feeding it the raw
-- 2,000 stalls it at 56%. The bar needs the count of what will actually be
-- applied, which is this.
DROP FUNCTION IF EXISTS bundle_alumni_stats(int);
CREATE FUNCTION bundle_alumni_stats(p_bundle_id int)
RETURNS TABLE (
  alumni_count bigint,
  alumni_product_count bigint,
  alumni_company_count bigint,
  eligible_prospect_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH visible AS (
    SELECT bp.persona, bp.payload, bp.is_alumni
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND EXISTS (
        SELECT 1 FROM data_bundles db
        WHERE db.id = p_bundle_id
          AND db.status = 'published'
          AND bundle_visible_to(db.id, auth.uid())
      )
  ),
  alum AS (
    SELECT v.persona, v.payload FROM visible v WHERE v.is_alumni
  )
  SELECT
    (SELECT count(*) FROM alum) AS alumni_count,
    (SELECT count(*) FROM alum
      WHERE alum.persona IN ('alum_product', 'product_leader', 'product_peer')
    ) AS alumni_product_count,
    -- "N of the bundle's companies have a BYU alum there today": the payload's
    -- current_company is CANON-mapped to the same names as the bundle company
    -- list, so a case-insensitive name match is exact by construction (raw
    -- experience employer names would NOT be).
    (SELECT count(DISTINCT co.id)
       FROM bundle_companies bc
       JOIN companies co ON co.id = bc.company_id
      WHERE bc.bundle_id = p_bundle_id
        AND lower(btrim(co.name)) IN (
          SELECT lower(btrim(a.payload ->> 'current_company'))
          FROM alum a
          WHERE a.payload ->> 'current_company' IS NOT NULL
        )
    ) AS alumni_company_count,
    -- Inverted: what a non-affinity subscriber KEEPS.
    (SELECT count(*) FROM visible v
      WHERE NOT is_alumni_only_prospect(v.is_alumni, v.persona)
    ) AS eligible_prospect_count;
$$;

COMMENT ON FUNCTION bundle_alumni_stats(int) IS 'Aggregate BYU-alumni counts (total, product-role, bundle companies with a current alum) plus the bundle-wide count a non-affinity subscriber receives, for a published, visible bundle — CAR-50/CAR-61 onboarding stats, repointed at the shared rule and given the eligible count in CAR-213. SECURITY DEFINER with the browse-visibility gate inlined; exposes counts only.';

REVOKE ALL ON FUNCTION bundle_alumni_stats(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION bundle_alumni_stats(int) TO authenticated, service_role;

-- Gains eligible_prospect_count: how many prospects a subscriber with NO
-- alumni affinity actually receives. The onboarding progress bar and the
-- Settings subscribe card both divide by this; dividing by the bundle's total
-- instead is what makes the bar stall at 56% and never complete.
DROP FUNCTION IF EXISTS bundle_company_stats(int);
CREATE FUNCTION bundle_company_stats(p_bundle_id int)
RETURNS TABLE (
  company_id int,
  name text,
  logo_url text,
  prospect_count bigint,
  eligible_prospect_count bigint,
  alumni_count bigint,
  product_alumni_count bigint
)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH live AS (
    SELECT
      lower(btrim(bp.payload ->> 'current_company')) AS cname,
      bp.is_alumni,
      bp.persona IN ('alum_product', 'product_leader', 'product_peer') AS is_product,
      is_alumni_only_prospect(bp.is_alumni, bp.persona) AS alumni_only
    FROM bundle_prospects bp
    WHERE bp.bundle_id = p_bundle_id
      AND bp.removed_in_version IS NULL
      AND bp.payload ->> 'current_company' IS NOT NULL
  ),
  stats AS (
    SELECT
      live.cname,
      count(*) AS prospect_count,
      count(*) FILTER (WHERE NOT live.alumni_only) AS eligible_prospect_count,
      count(*) FILTER (WHERE live.is_alumni) AS alumni_count,
      count(*) FILTER (WHERE live.is_alumni AND live.is_product) AS product_alumni_count
    FROM live
    GROUP BY live.cname
  )
  SELECT
    co.id,
    co.name,
    co.logo_url,
    COALESCE(s.prospect_count, 0),
    COALESCE(s.eligible_prospect_count, 0),
    COALESCE(s.alumni_count, 0),
    COALESCE(s.product_alumni_count, 0)
  FROM bundle_companies bc
  JOIN companies co ON co.id = bc.company_id
  LEFT JOIN stats s ON s.cname = lower(btrim(co.name))
  WHERE bc.bundle_id = p_bundle_id;
$$;

COMMENT ON FUNCTION bundle_company_stats(int) IS 'Per-company prospect/eligible/BYU-alumni/product-role counts for a bundle (CAR-77 onboarding picker; eligible count added CAR-213 so non-affinity users get honest numbers). SECURITY INVOKER; subscriber-only RLS on the underlying tables applies.';

REVOKE ALL ON FUNCTION bundle_company_stats(int) FROM public, anon;
GRANT EXECUTE ON FUNCTION bundle_company_stats(int) TO authenticated, service_role;

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
        AND is_byu_family_school(s.name)
    )
  GROUP BY cc.company_id;
$$;

COMMENT ON FUNCTION user_company_alumni_counts() IS 'Per-company counts of the calling user''s current BYU-alumni contacts — total and product-role — for the CAR-50 onboarding picker; repointed at the shared rule in CAR-213. SECURITY INVOKER; RLS applies.';

REVOKE ALL ON FUNCTION user_company_alumni_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION user_company_alumni_counts() TO authenticated, service_role;
