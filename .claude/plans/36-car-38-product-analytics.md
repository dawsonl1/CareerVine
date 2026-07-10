# CAR-38 — Product analytics: event tracking across web, extension, and MCP

## Goal

PM-grade instrumentation so changes to CareerVine can be evaluated with data: activation funnel, outreach-loop health, feature adoption, AI draft acceptance, and guardrails — with feature flags/experiments and session replay available for future evaluation work.

## Architecture (decided with Dawson 2026-07-10)

**Hybrid:** PostHog Cloud (free tier) is the analytics brain — funnels, retention, replay (masked), flags/experiments, release annotations. A first-party Supabase table (`analytics_events`) mirrors business-critical **outcome** events (`email_sent`, `reply_received`, `meeting_created`) so outcome data lives beside domain data and survives any vendor change.

## Metrics (signed off 2026-07-10)

**Framework:** North Star + input-metric tree; HEART's task-success lens per feature.

- **North Star: replies received/week** (thread-attributed via Gmail threadId — a reply counts only when tied to outreach we sent; other inbound tracked separately). **Meetings/week** beside it as the quality check.
- **Volume inputs:** WAU, sends per active user/week, follow-up adherence (% of due follow-ups actually sent — computed via SQL over domain tables, not events).
- **Quality inputs:** reply rate per send, time-to-first-reply, meetings per reply, reply rate AI-assisted vs manual.
- **AI acceptance:** sent-as-is / edited / discarded trio **+ edit ratio** (share of draft surviving to send).
- **Feature adoption × effectiveness:** % of WAU using extension / MCP / AI / transcripts / bundles, crossed with reply rate.
- **New-user metrics (Dawson's list):** extension installs; extension logins; user counts (signups, WAU); time from extension install → 5 contacts imported; bundle subscribed; time to having emailed people at 5 distinct companies. Threshold metrics implemented as one-time `milestone_reached` events (`contacts_5`, `companies_emailed_5`) computed server-side and recorded in a `user_milestones` table (durable first-crossed timestamps). D1/D7/D30 cohort retention and week-1 active days come free from PostHog.
- **Guardrails:** api_error rate by route, send_cap hits, AI-draft latency.
- **Autocapture: ON** (retroactive safety net); dashboards built only on curated events. No guided-onboarding UI in this ticket — metrics only.

**Principles**

- One typed event registry, `object_verb` names, ~30–40 deliberate events. No direct PostHog calls from components — everything through a thin `track()` layer (vendor swappable).
- Server-side events are the backbone (trustworthy, adblock-proof). Client events only where the server can't see intent (page views, draft editing, modal funnels).
- Every event carries `user_id` (Supabase UUID — same identity on all surfaces) and `surface`: `web | server | extension | mcp`.
- Everything no-ops gracefully when PostHog env vars are absent (dev, and until keys are provisioned).

## Slices

### 1. Analytics core (`careervine/src/lib/analytics/`)

- `events.ts` — typed event registry: event name → property shape, `MIRRORED_EVENTS` list for the Supabase mirror. Lifecycle (`user_signed_up`, `gmail_connected`, `calendar_connected`), contacts (`contact_imported` w/ source, `contact_viewed`), outreach (`draft_created` w/ source, `email_sent`, `follow_up_sequence_created`, `email_scheduled`, `reply_received`, `meeting_created`), AI (`ai_draft_generated`, `ai_suggestions_generated`, `transcript_processed`), bundles (`bundle_subscribed`/`unsubscribed`), guardrails (`send_cap_hit`, `api_error`), MCP (`mcp_tool_called`), extension (`profile_scraped`, `import_previewed`).
- `server.ts` — `posthog-node` singleton (`flushAt: 1`, capture + `shutdown`-safe on serverless), `trackServer(userId, event, props)`; mirrors `MIRRORED_EVENTS` into `analytics_events` via service client. Fire-and-forget, never throws into callers.
- `client.tsx` — `posthog-js` provider: init with `NEXT_PUBLIC_POSTHOG_KEY/HOST`, `identify(user.id)` on auth change + `reset()` on sign-out, manual App Router pageview capture, session replay with `maskAllInputs` + text masking on email/contact content, and a typed `track()` for components.

### 2. Supabase mirror + milestones (migration `2026….sql`)

- `analytics_events`: `id bigint identity, user_id uuid, event text, surface text, properties jsonb, created_at timestamptz default now()`. RLS enabled; service-role writes only. Index on `(user_id, event, created_at)`.
- `user_milestones`: `user_id uuid, milestone text, reached_at timestamptz default now(), primary key (user_id, milestone)`. Insert-once (`on conflict do nothing`); the insert winning is what triggers the one-time `milestone_reached` event. Milestones v1: `contacts_5` (checked on contact import), `companies_emailed_5` (distinct companies emailed, checked on send).

### 3. Web server instrumentation

- `api-handler.ts`: add `ctx.track(event, props)` (pre-bound to the authed user + `surface: 'server'`); auto-capture `api_error` in the catch path with route + method (no bodies). Zero behavior change for existing routes.
- Explicit `ctx.track` calls in the ~15 meaningful routes: gmail send/schedule/follow-ups, ai draft routes, contacts import/bulk-import, extension parse-profile, bundles subscribe/unsubscribe/apply, transcripts, calendar create-event, settings key saves, gmail/calendar OAuth callbacks (`gmail_connected` etc.).
- Outcome hooks: `email_sent` in `lib/email-send.ts` (also carries `is_follow_up`, `is_scheduled`, `ai_assisted` where known); `send_cap_hit` at the daily-cap rejection; `reply_received` where Gmail sync detects a reply; `meeting_created` in calendar create-event.

### 4. Web client instrumentation

Provider added in `layout.tsx` (inside AuthProvider). Pageviews on route change. A handful of client-only events: compose modal opened, AI draft inserted-then-edited vs sent-as-is vs discarded (acceptance-rate trio), quick-capture used.

### 5. MCP instrumentation

Tracking proxy in `register-tools.ts`: wrap `server.registerTool` so every callback emits `mcp_tool_called` (`tool`, `success`, duration) with `user_id` from `uid()` (guarded — skips silently if no user context). Covers all 27 tools in one place; no per-tool edits.

### 6. Chrome extension instrumentation

Tiny `track.js` posting to PostHog's public `/capture` endpoint (the project key is public by design) with `surface: 'extension'`. Events: `extension_installed` (fired from `chrome.runtime.onInstalled`, anonymous device id, merged into the person on login via identify), `extension_logged_in`, `profile_scraped`, `import_previewed`; `contact_imported` stays server-side. Manifest host permission for the PostHog host.

### 7. Release annotations + deploy

- `scripts/posthog-annotate.mjs` — creates a PostHog annotation ("deploy <sha>") when `POSTHOG_PERSONAL_API_KEY` is present; wired into the Vercel build (`build` script), silent no-op otherwise.
- Vercel env vars (Claude-managed, rule 28): `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `POSTHOG_PERSONAL_API_KEY` — set once Dawson provisions the PostHog project (only true manual step: creating the account / pasting keys).

### 8. Tests + docs

Vitest: registry shape, server track no-op without env, mirror routing of `MIRRORED_EVENTS`, api-handler `ctx.track` binding + `api_error` capture, MCP wrapper emits with tool name and survives tracking failures. README gets a product-level "built-in product analytics" note.

## Verification

`npm run test` + `npm run build` from `careervine/`; migration via `supabase db push --dry-run` → push on landing (rule 27). No UI-visible changes → no browser pass needed (rule 13).

## Out of scope (follow-ups)

In-app admin metrics dashboard (CAR-22 — this ticket is its data foundation), email open/click pixels, A/B experiment usage itself.
