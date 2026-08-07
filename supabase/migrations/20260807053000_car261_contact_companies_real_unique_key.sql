-- CAR-261: give contact_companies a uniqueness constraint that actually fires,
-- and delete the duplicate employment rows it should have prevented.
--
-- Since init (20260201214637_init.sql:191) the table has carried exactly one
-- unique index:
--
--   CREATE UNIQUE INDEX contact_companies_unique_idx
--     ON contact_companies (contact_id, company_id, start_date);
--
-- It keys on `start_date`, a date column. Every write path in the app either
-- sets `start_date: null` explicitly or omits it; the app populates `start_month`
-- (text) instead. Measured on production 2026-08-07: 0 of 88,204 rows carry a
-- non-null start_date. Postgres treats NULLs as distinct in a btree unique
-- index, so (contact_id, company_id, NULL) has never collided with itself and
-- the index has never rejected a single row.
--
-- Result, measured the same day: 70 surplus rows across 65 groups and 61
-- contacts, and EVERY account in the system is affected, not one. 61 of those 65
-- groups have fully contiguous row ids (67426/67427/67428, 5091/5092, 72/73),
-- which means one INSERT wrote all the copies: the duplication is intra-payload,
-- from the bulk-import CREATE branch building rows 1:1 off the actor payload
-- with no key-collapse. The code fix ships in the same PR.
--
-- KEY CHOICE — end_month is IN the key, deliberately.
--
-- The app's own `employmentKey()` (careervine/src/lib/scrape-merge.ts) keys on
-- (company_id, title, start_month) and omits end_month, because end_month is the
-- field most likely to change between scrapes ("Present" becomes "Oct 2025" when
-- someone leaves) and the merge has to recognise that as the SAME stint to
-- update rather than re-insert. That is right for matching and wrong for
-- uniqueness. Keying this index the same way was measured against production and
-- would have deleted 15 more rows that are real history, not duplicates:
--
--   Cody Wang    AWS  "Software Development Engineer Intern"  ends Aug 2015 AND Aug 2016
--   Kirk Smith   Revetize "VP corporate partnerships"         ends Sep 2020 AND Jan 2022
--
-- Two internships and two stints. So the database enforces only EXACT duplicates
-- and leaves semantic identity to application code, which can reconcile drift
-- instead of destroying a row it cannot reason about.
--
-- NULLS NOT DISTINCT (Postgres 15+; production is 17.6) is what makes this fire
-- at all: title, start_month and end_month are all nullable, and without it the
-- new index would be exactly as inert as the one it replaces.

BEGIN;

-- 1. Collapse existing exact duplicates, keeping the lowest id per natural key.
--
-- Safe on both counts, both verified against production rather than assumed:
--   * Nothing foreign-keys to contact_companies.id, so no reference is orphaned.
--   * Within every one of the 65 duplicate groups, location_id, workplace_type,
--     is_current and source are IDENTICAL across the copies, so "keep the lowest
--     id" discards no field that differs.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY contact_id, company_id, title, start_month, end_month
           ORDER BY id
         ) AS rn
  FROM contact_companies
)
DELETE FROM contact_companies cc
USING ranked r
WHERE r.id = cc.id
  AND r.rn > 1;

-- 2. Retire the index that never worked.
DROP INDEX IF EXISTS public.contact_companies_unique_idx;

-- 3. The real one. Named for what it keys on, so the next person reading
--    \d contact_companies is not misled the way the old name managed to be.
CREATE UNIQUE INDEX contact_companies_natural_key_idx
  ON public.contact_companies (contact_id, company_id, title, start_month, end_month)
  NULLS NOT DISTINCT;

DO $$
DECLARE
  dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM contact_companies
    GROUP BY contact_id, company_id, title, start_month, end_month
    HAVING count(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'CAR-261: % duplicate groups survived the collapse', dupes;
  END IF;
  RAISE NOTICE 'CAR-261: contact_companies now unique on (contact_id, company_id, title, start_month, end_month)';
END $$;

COMMIT;
