-- CAR-229: the companies page built its per-company contact counts by pulling
-- EVERY contact_companies row for the user into the browser and aggregating in
-- JS (fetchUserEmploymentRows). On a 2,000-contact account that is ~18,000 rows
-- fetched as 18 sequential 1,000-row pages, 6.6s of pure serial paging before
-- anything renders, and it grows linearly with the network.
--
-- This does the same aggregation in one round trip. The client then fetches
-- per-person rows only for the companies it actually shows, which is bounded by
-- the view (targets/pursuing/in_play are tens of companies, not thousands).
--
-- Semantics are a faithful port of the JS aggregation it replaces, including
-- three subtleties that are easy to get wrong:
--   * bench contacts are counted ONLY in bench_count, never as current/former.
--   * a contact with several roles at one company collapses to a single person,
--     and "current wins" over a former role (the boomeranger rule: someone who
--     left and came back is current, not former).
--   * former_count therefore counts people with no current role at that company,
--     not rows with is_current = false.
--
-- security invoker + `where c.user_id = auth.uid()`: a signed-in caller only ever
-- aggregates their own contacts, and the contacts/contact_companies RLS policies
-- apply on top. Not granted to anon.
-- The scope filter lives here rather than in the client because it is what
-- bounds the response: on the reference account the unfiltered aggregate is
-- 7,328 companies, while the `/companies` default view (in_play) needs 657.
-- p_extra_company_ids carries the user's target companies, which are always
-- shown regardless of contact count and so must keep their counts.
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
  )
  select agg.company_id, agg.current_count, agg.former_count, agg.bench_count, agg.current_prospect_count
  from agg
  where agg.company_id = any(p_extra_company_ids)
     or case p_scope
          -- 'targets' selects purely from p_extra_company_ids.
          when 'targets'  then false
          when 'pursuing' then agg.current_prospect_count >= 1
          when 'in_play'  then agg.current_count >= 1
          else agg.current_count + agg.former_count >= p_min_contacts
        end;
$$;

revoke all on function public.company_network_counts(text, int, bigint[]) from public, anon;
grant execute on function public.company_network_counts(text, int, bigint[]) to authenticated;

-- No new index needed: contact_companies_unique_idx (init.sql) is already keyed
-- (contact_id, company_id, start_date), and its leading column serves the
-- contacts join this aggregate drives.
