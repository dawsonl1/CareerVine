# CAR-98 — Tier-count chips 503 on cold load → one RPC

## Investigation (live browser)

`getNetworkTierCounts` fires three `HEAD` `count=exact` requests. On a **cold** `/contacts`
load they all return **503** (Cloudflare/Supabase edge); the 6 data `GET`s on the same load
succeed. Solo, warm SPA re-nav, and 24-concurrent bursts all return `200/206` — so it is not
the query, contention, or auth. It is a Cloudflare-edge quirk with `HEAD` requests on a
freshly-established connection. The error is swallowed (`.catch(() => {})`), so the only
impact is the tier chips populate after the full load instead of instantly.

## Fix — single RPC, POST not HEAD

Replace the 3 `HEAD count=exact` requests with one `supabase.rpc("network_tier_counts")`
(a `POST /rest/v1/rpc/...`). Removes the failing `HEAD` shape and cuts 3 requests → 1.

### Migration `supabase/migrations/20260712010000_network_tier_counts_rpc.sql`
```sql
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
    count(*) filter (where network_status = 'bench')     as bench
  from public.contacts
  where user_id = auth.uid();
$$;

revoke all on function public.network_tier_counts() from public, anon;
grant execute on function public.network_tier_counts() to authenticated;
```
- `security invoker` + `where user_id = auth.uid()`: a signed-in user only ever counts their
  own rows; contacts RLS also applies. Not exposed to `anon`.

### `careervine/src/lib/queries.ts`
```ts
export async function getNetworkTierCounts() {
  const { data, error } = await supabase.rpc("network_tier_counts").single();
  if (error || !data) return { active: 0, prospect: 0, bench: 0 };
  return {
    active: Number(data.active) || 0,
    prospect: Number(data.prospect) || 0,
    bench: Number(data.bench) || 0,
  };
}
```
Drop the `userId` param (RPC uses `auth.uid()`); update the sole caller in
`careervine/src/app/contacts/page.tsx` (`getNetworkTierCounts()`).

### Types
Regenerate/extend `database.types.ts` Functions entry for `network_tier_counts`, or type the
`.rpc` result inline if the generated types aren't refreshed here.

## Tests

Extend `src/__tests__/` with a `getNetworkTierCounts` unit test: mock `supabase.rpc` to
return `{active,prospect,bench}` and assert the mapped result + the null/error fallback to
zeros. (The old tests, if any, referenced the 3-query path — update them.)

## Verify

`npm run test` + `npm run build`. Apply migration on landing (rule 27). Cold-reload
`/contacts` on the deploy: confirm a single `rpc/network_tier_counts` `200` (no `503`s) and
chips show counts immediately. RLS check: the function returns only the caller's counts.
