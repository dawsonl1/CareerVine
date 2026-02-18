-- User-defined email templates for AI email generation
create table if not exists public.email_templates (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  prompt text not null,
  is_default boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS
alter table public.email_templates enable row level security;

create policy "Users can manage their own templates"
  on public.email_templates
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index idx_email_templates_user_id on public.email_templates(user_id);
