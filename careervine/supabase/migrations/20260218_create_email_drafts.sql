-- Email drafts table for auto-saving compose state
create table if not exists public.email_drafts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text,
  cc text,
  bcc text,
  subject text,
  body_html text,
  thread_id text,
  in_reply_to text,
  references_header text,
  contact_name text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- RLS
alter table public.email_drafts enable row level security;

create policy "Users can manage their own drafts"
  on public.email_drafts
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index for fast lookup
create index idx_email_drafts_user_id on public.email_drafts(user_id);
