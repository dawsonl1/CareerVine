-- CAR-80: email-derived internal-account analytics exclusion (survives delete/recreate).
--
-- CAR-60 keyed exclusion on a hand-maintained list of Supabase user UUIDs. Supabase mints
-- a new UUID on every account creation, so deleting + recreating an internal/test account
-- with the same email dropped it out of the list and it started polluting analytics again.
--
-- This makes "internal" a property of the user, derived from email at signup:
--   * an exact-email allowlist (seeded from CAR-60's accounts) + the @careervine.app domain,
--   * mirrored into auth.users.app_metadata as a JWT claim the web client and extension read
--     synchronously (no fetch, no init race),
--   * resolved server-side (which only has a user id) via user_is_internal().
-- Recreating an account with a known-internal email re-marks it on the first insert.

-- 1. Exact-email allowlist. RLS ON with NO policies: clients (anon/authenticated/service_role
--    via PostgREST) can never read it. The SECURITY DEFINER functions below are owned by
--    postgres and read it as the table owner, which bypasses RLS — so the rule still works.
create table if not exists public.internal_analytics_emails (
  email text primary key,
  note text,
  created_at timestamptz not null default now()
);
alter table public.internal_analytics_emails enable row level security;

-- 2. Seed the allowlist from CAR-60's known internal accounts, identified by the UUIDs
--    already committed in chrome-extension/env/production.json. Emails are pulled from
--    auth.users at apply time, so no plaintext personal email is committed to source.
--    Already-deleted accounts (e.g. dae9cb35) simply contribute no row.
insert into public.internal_analytics_emails (email, note)
select lower(u.email), 'seeded from CAR-60 internal account ' || u.id::text
from auth.users u
where u.id in (
  '63198da1-446a-43e0-b845-7ce708819cbe',
  'd24b6d9b-1edb-49ce-9273-a6c87592cfb1',
  '296266b9-641d-4e7a-ae3c-d27de3b49fe0',
  'b376e8af-7a9c-4540-836e-f83ffd7e25eb',
  'dae9cb35-e06b-4615-a7a2-6dfbaced0c5d',
  'c82baf35-4123-4018-a504-313efcd6c4d1'
)
and u.email is not null
on conflict (email) do nothing;

-- 3. Authoritative rule: internal iff the @careervine.app domain OR in the allowlist.
create or replace function public.is_internal_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_email is not null and (
    lower(p_email) like '%@careervine.app'
    or exists (
      select 1 from public.internal_analytics_emails e
      where e.email = lower(p_email)
    )
  );
$$;

revoke all on function public.is_internal_email(text) from public;

-- 4. Server-side resolver. Server analytics only ever has the user id; this maps id -> the
--    authoritative rule. SECURITY DEFINER so it can read auth.users; execute granted to
--    service_role only (never anon/authenticated). Returns false for unknown ids.
create or replace function public.user_is_internal(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.is_internal_email((select email from auth.users where id = uid)),
    false
  );
$$;

revoke all on function public.user_is_internal(uuid) from public;
grant execute on function public.user_is_internal(uuid) to service_role;

-- 5. Mirror the flag into app_metadata (the JWT claim the client + extension read). Extend
--    the existing signup trigger function; the UPDATE runs inside the signup transaction,
--    so the value is present in the very first token GoTrue mints for the new user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, first_name, last_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'first_name', ''),
    coalesce(new.raw_user_meta_data ->> 'last_name', ''),
    new.email
  )
  on conflict (id) do nothing;

  -- CAR-80: mark internal accounts so analytics excludes them. Email-derived, so it
  -- survives delete/recreate; mirrored into app_metadata for the client/extension check.
  if public.is_internal_email(new.email) then
    update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object('is_internal', true)
    where id = new.id;
  end if;

  return new;
end;
$$;

-- 6. Backfill the claim for existing internal accounts (the seed above already populated
--    the allowlist, so the rule resolves correctly here).
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
  || jsonb_build_object('is_internal', true)
where public.is_internal_email(email);
