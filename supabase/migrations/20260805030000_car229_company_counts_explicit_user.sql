-- CAR-229 follow-up 2: company_network_counts keyed only on auth.uid(), which
-- is NULL for the MCP server.
--
-- The web app reaches src/lib/data through the browser client (anon key + user
-- session), so auth.uid() is the tenant and RLS backs it. The MCP server
-- injects the SERVICE-ROLE client into the same modules and scopes every call
-- explicitly instead (see src/mcp/lib/db.ts). Under service-role, auth.uid() is
-- NULL and RLS is bypassed, so the previous definition returned ZERO ROWS for
-- every MCP company query — list_companies and get_company would have gone
-- quietly empty rather than erroring.
--
-- Caught by src/mcp/__tests__/db-scoping.test.ts, which asserts every query an
-- MCP entry point drives is covered by an ownership assertion. The rpc was not,
-- because it carried no tenant argument at all.
--
-- Fix: take the user explicitly, defaulting to auth.uid() so the web path is
-- unchanged. This is the same explicit-ownership model the rest of the MCP
-- surface already uses, and it is safe in both directions:
--   * service-role caller: RLS is bypassed, and `c.user_id = v_user_id` is what
--     scopes the read — which is exactly why the argument must be passed, and
--     why the scoping test now sees a tenant id in the rpc args.
--   * authenticated caller passing someone else's id: security invoker keeps
--     RLS on contacts/contact_companies in force, so the filter intersects with
--     "rows you can see" and the result is empty. A user cannot read another
--     tenant by lying about the argument.
drop function if exists public.company_network_counts(text, int, bigint[]);

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
    where c.user_id = coalesce(p_user_id, auth.uid())
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

revoke all on function public.company_network_counts(uuid, text, int, bigint[]) from public, anon;
grant execute on function public.company_network_counts(uuid, text, int, bigint[]) to authenticated, service_role;
