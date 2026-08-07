-- CAR-271: let a user delete a company profile, and keep it deleted.
--
-- `companies` is a GLOBAL lookup table: no user_id, `SELECT USING (true)` for
-- every authenticated user, and no DELETE policy at all. Three FKs reference it
-- with no ON DELETE clause (contact_companies, user_companies, scrape_runs), so
-- a hard delete raises 23503 for any company anyone has an employment row at,
-- and would remove the company from every other tenant besides. Deletion is
-- therefore necessarily a PER-USER tombstone -- which is also exactly what makes
-- it survive a bundle resync, so the constraint and the requirement agree.
--
-- The tombstone is a target_companies row. That table is already the user-scoped
-- scope layer whose design is soft flags that outlive what they hide:
-- is_targeted is "a soft flag so un-targeting never destroys pipeline data".
-- is_deleted is its stronger sibling -- not merely "not a target", but "not in my
-- workspace at all, and do not recreate it".
--
-- Putting the flag HERE rather than in a separate suppression table is what
-- closes the two resurrection vectors structurally instead of by remembering.
-- Both paths key on row EXISTENCE:
--
--   * ensureCompanyTargets (company-helpers.ts) inserts only companies MISSING a
--     row, so a newly imported contact cannot re-target a tombstoned company.
--   * /api/target-companies/bulk-import updates research fields only on an
--     existing row, with is_targeted deliberately excluded (CAR-258).
--
-- A separate table would invert both: the target row would be gone, so each path
-- would happily recreate it and correctness would rest on a check someone
-- remembered to add. This is CAR-258's rule ("nothing automatic may reverse a
-- hand-set un-target") extended to a second flag, at call sites that already
-- implement it.
--
-- Deliberately NOT touched: the global companies row, and the contact's
-- employment record. Deleting a company profile keeps every contact who works
-- there searchable, still labelled "works at X", and still eligible for
-- outreach. findOrCreateCompany will therefore keep matching the row after a
-- delete, and that is correct rather than a leak.

ALTER TABLE target_companies
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN target_companies.is_deleted IS
  'User deleted this company from their workspace: the row survives as a tombstone so nothing recreates it, and every read must exclude it. Stronger than is_targeted=false, which still shows on the companies list. Never written by import, sync or any automatic path.';

-- Every read that filters this flag pays for it on the company-wide row, which
-- is the one the tombstone is written to. Partial so it stays small: deleted
-- companies are the rare case.
CREATE INDEX IF NOT EXISTS target_companies_deleted_idx
  ON target_companies (user_id, company_id)
  WHERE is_deleted;

-- ── company_network_counts: drop tombstoned companies from BOTH legs ────────
--
-- This rpc is the chokepoint for the companies list. It derives candidates from
-- contact_companies (companies you know someone at) and unions in the caller's
-- extra ids (targets). The contact-derived leg is precisely what puts a company
-- back on the page after a bundle resync creates a contact who works there, so
-- filtering it here is the requirement, not a nicety.
--
-- The extras leg is filtered too, even though the TypeScript caller already
-- excludes deleted rows when it builds that array. Depending on the caller to
-- pre-filter would make the rpc's correctness a property of one call site, and
-- selectCompanyIds (company-queries.ts) WIDENS -- it unconditionally seeds the
-- candidate set with every target id -- which is exactly the shape of bug that
-- produces. Both legs, independently.
--
-- Signature and body are otherwise unchanged from
-- 20260805030000_car229_company_counts_explicit_user.sql: still security
-- invoker, still taking p_user_id explicitly so the service-role MCP path works
-- (auth.uid() is NULL there, and the previous keying on it returned zero rows
-- for every MCP company query).
create or replace function public.company_network_counts(
  p_user_id uuid default null,
  p_scope text default 'all',
  p_min_contacts int default 1,
  p_extra_company_ids bigint[] default '{}'::bigint[]
)
returns table(
  company_id bigint,
  current_count bigint,
  former_count bigint,
  bench_count bigint,
  current_prospect_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with resolved_user as (
    select coalesce(p_user_id, auth.uid()) as user_id
  ), deleted as (
    -- The tombstone lives on the company-wide scope row. An office-scoped row
    -- is a pipeline for one location and never a deletion.
    select tc.company_id
    from public.target_companies tc, resolved_user ru
    where tc.user_id = ru.user_id
      and tc.location_id is null
      and tc.is_deleted
  ), per_pair as (
    -- One row per (company, contact): collapses multiple roles at the same
    -- company, with current winning over former.
    select
      cc.company_id,
      cc.contact_id,
      c.network_status,
      coalesce(bool_or(cc.is_current), false) as is_current
    from public.contact_companies cc
    join public.contacts c on c.id = cc.contact_id
    where c.user_id = (select user_id from resolved_user)
    group by cc.company_id, cc.contact_id, c.network_status
  ), agg as (
    select
      per_pair.company_id::bigint                                              as company_id,
      count(*) filter (where network_status <> 'bench' and is_current)         as current_count,
      count(*) filter (where network_status <> 'bench' and not is_current)     as former_count,
      count(*) filter (where network_status = 'bench')                         as bench_count,
      count(*) filter (where network_status = 'prospect' and is_current)       as current_prospect_count
    from per_pair
    group by per_pair.company_id
  ), selected as (
    select agg.company_id
    from agg
    where case p_scope
            -- 'targets' selects purely from p_extra_company_ids.
            when 'targets'  then false
            when 'pursuing' then agg.current_prospect_count >= 1
            when 'in_play'  then agg.current_count >= 1
            else agg.current_count + agg.former_count >= p_min_contacts
          end
    union
    -- Extras are unioned in, not filtered for, so a target with no contacts at
    -- all still comes back (with zero counts) instead of vanishing.
    select unnest(p_extra_company_ids)::bigint
  )
  select
    s.company_id,
    coalesce(a.current_count, 0)          as current_count,
    coalesce(a.former_count, 0)           as former_count,
    coalesce(a.bench_count, 0)            as bench_count,
    coalesce(a.current_prospect_count, 0) as current_prospect_count
  from selected s
  left join agg a on a.company_id = s.company_id
  where not exists (select 1 from deleted d where d.company_id = s.company_id)
  order by s.company_id;
$$;

revoke all on function public.company_network_counts(uuid, text, int, bigint[]) from public, anon;
grant execute on function public.company_network_counts(uuid, text, int, bigint[]) to authenticated, service_role;
