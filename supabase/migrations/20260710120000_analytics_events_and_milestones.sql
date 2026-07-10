-- CAR-38: first-party analytics mirror + new-user value milestones.
--
-- analytics_events mirrors business-critical outcome events (email_sent,
-- reply_received, meeting_created) from the tracking layer so outcome data
-- lives next to domain data and survives any analytics-vendor change.
-- Writes come exclusively from the service role; there are deliberately no
-- RLS policies, so anon/authenticated roles can neither read nor write.
-- Admin reads go through service-role API routes.

create table if not exists public.analytics_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  event text not null,
  surface text not null default 'server',
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists analytics_events_user_event_time_idx
  on public.analytics_events (user_id, event, created_at desc);
create index if not exists analytics_events_event_time_idx
  on public.analytics_events (event, created_at desc);

alter table public.analytics_events enable row level security;

-- One row per (user, milestone), inserted the first time the threshold is
-- crossed. The primary key is the dedupe: the insert that wins emits the
-- one-time milestone_reached analytics event. reached_at gives durable
-- time-to-value measurements independent of the analytics vendor.
create table if not exists public.user_milestones (
  user_id uuid not null,
  milestone text not null,
  reached_at timestamptz not null default now(),
  primary key (user_id, milestone)
);

alter table public.user_milestones enable row level security;
