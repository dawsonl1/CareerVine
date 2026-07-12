-- CAR-98: the contacts page loaded per-tier chip counts via three
-- `HEAD ... Prefer: count=exact` requests (getNetworkTierCounts). On a cold
-- page load those HEAD requests consistently 503 at the Supabase/Cloudflare
-- edge (the data GETs on the same load succeed; solo/warm/concurrent HEADs
-- succeed) — a HEAD-on-fresh-connection quirk. Replace the three HEADs with a
-- single RPC (a POST), which sidesteps the failing shape and cuts 3 requests
-- to 1.
--
-- security invoker + `where user_id = auth.uid()`: a signed-in caller only ever
-- counts their own contacts, and the contacts RLS policy applies as well. Not
-- granted to anon.
create or replace function public.network_tier_counts()
returns table(active bigint, prospect bigint, bench bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where network_status = 'active')   as active,
    count(*) filter (where network_status = 'prospect') as prospect,
    count(*) filter (where network_status = 'bench')    as bench
  from public.contacts
  where user_id = auth.uid();
$$;

revoke all on function public.network_tier_counts() from public, anon;
grant execute on function public.network_tier_counts() to authenticated;
