-- CAR-229 follow-up: two defects in company_network_counts, both found by the
-- TS<->SQL parity test in src/__integration__/company-network-counts.itest.ts.
-- A separate migration rather than an edit to 20260805010000, which is already
-- applied to production (rule 10: never reshape an applied migration).
--
-- DEFECT 1 — p_extra_company_ids could not resurrect a company with no
-- employment rows. The final select read `from agg`, and `agg` derives from
-- contact_companies, so a company with zero contacts has no agg row and
-- `agg.company_id = any(p_extra_company_ids)` could never match it. Both the
-- original header and the caller's doc comment promised the opposite ("targets
-- ride along as extras so they keep their counts even when they have no
-- contacts yet"), and selectCompanyIds unconditionally seeds its result with
-- every target id, so SQL and TS disagreed for every zero-contact target in
-- every scope. Fixed by selecting from the union of the qualifying set and the
-- extras, left-joining the aggregate, and coalescing the counts to 0.
--
-- DEFECT 2 — no stable order, and the caller did not paginate. PostgREST caps a
-- response at max_rows (1000, supabase/config.toml) and truncates SILENTLY with
-- error: null. The `all` scope returns 4,708 companies on the reference
-- account, so it was being cut to an arbitrary 1000 with no error, and
-- getCompanies applies its name search AFTER that cut, meaning an all-companies
-- search could not find a company that fell outside the arbitrary window. This
-- was a REGRESSION: the client-side sweep this RPC replaced did page through
-- its reads. The caller now walks .range() windows, which requires a stable
-- total order to avoid duplicating or dropping rows at page boundaries, so the
-- function orders by company_id.
create or replace function public.company_network_counts(
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
  with per_pair as (
    -- One row per (company, contact): collapses multiple roles at the same
    -- company, with current winning over former.
    select
      cc.company_id,
      cc.contact_id,
      c.network_status,
      coalesce(bool_or(cc.is_current), false) as is_current
    from public.contact_companies cc
    join public.contacts c on c.id = cc.contact_id
    where c.user_id = auth.uid()
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
  order by s.company_id;
$$;

revoke all on function public.company_network_counts(text, int, bigint[]) from public, anon;
grant execute on function public.company_network_counts(text, int, bigint[]) to authenticated;
