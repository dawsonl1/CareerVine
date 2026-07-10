# CAR-58 — PostHog: distinguish "clicked Connect Gmail" from "actually connected"

## Diagnosis (verified against live data 2026-07-10)

- `gmail_connected` fires only from `/api/gmail/callback` after a successful token
  exchange + upsert — the emit site itself is correct.
- **Zero** `gmail_connected` events exist in PostHog. All 5 `gmail_connections` rows
  predate the CAR-38 analytics deploy (latest created 2026-07-08; tracking shipped
  2026-07-10), so every existing connection is invisible to PostHog forever.
- Observed confusion: user `d24b6d9b` (connected since 2026-03-25) sent an email today
  with the Activation funnel showing 0 connections, while real new user `50df25ca`
  browsed `settings?tab=integrations` without connecting — only `$autocapture` noise
  distinguishes them.
- Connect CTAs (`/api/gmail/auth` links in setup-banner, Settings → Integrations,
  Inbox empty state) emit no curated event, so consent-screen abandonment is
  unmeasurable.

## Changes

1. **Registry** (`src/lib/analytics/events.ts`) — client intent events:
   - `gmail_connect_clicked: { source: "setup_banner" | "settings" | "inbox" }`
   - `calendar_connect_clicked: { source: "setup_banner" | "settings" }`

2. **CTA instrumentation** — `track()` onClick on the five Connect buttons:
   `setup-banner.tsx` (gmail + calendar), `settings/integrations-section.tsx`
   (gmail + calendar), `inbox/page.tsx` (gmail).

3. **Person-state properties** (`src/lib/analytics/server.ts`) — connection events
   also `$set` PostHog person properties so current state is queryable independent of
   event history:
   - `gmail_connected` → `{ gmail_connected: true }` (+ `calendar_connected: true`
     when the calendar event fires alongside)
   - `gmail_disconnected` → `{ gmail_connected: false, calendar_connected: false }`
     (revokeAccess deletes the whole row, calendar included)
   - `calendar_connected` → `{ calendar_connected: true }`
   - `calendar_disconnected` → `{ calendar_connected: false }`

4. **Backfill** — `scripts/posthog-backfill-connection-state.mjs`: one-off `$set` of
   `gmail_connected` / `calendar_connected` (+ `gmail_connected_at`) for existing
   `gmail_connections` rows, via the ingest API. Run once after merge.

5. **Insight** — new funnel "Gmail connect: clicked → connected"
   (`gmail_connect_clicked` → `gmail_connected`, 1-day window) added to the
   CareerVine dashboard (1827570) via the PostHog API.

6. **Tests** — extend `src/__tests__/analytics.test.ts`: `$set` payloads on the four
   connection events, no `$set` on other events.

## Scope expansion (Dawson, 2026-07-10): full analytics-accuracy audit fixes

A four-agent audit of every PostHog emit site found more CAR-58-class bugs;
all are fixed on this same PR:

1. **user_signed_up identity** — now `identify(new user id)` (returned even
   while unconfirmed) fires BEFORE the event, so signups can't land on an
   anonymous person that later merges into the wrong account, and
   different-device email confirmation keeps the event on the right person.
2. **reply_received** — `ai_assisted` now populated (new `email_messages.ai_assisted`
   column stamped at send time, read per-thread at attribution); dedupe made
   race-proof via `ignoreDuplicates` upsert RETURNING only actually-inserted rows.
3. **meeting_created** — pushed into `createCalendarEvent` so MCP
   `create_meeting` counts; route-level emit removed (no double-count).
4. **contact_imported + contacts_5** — pushed into `importPeopleChunk` with the
   ACTUAL created count (`analyticsSource` option): covers bundle apply,
   discovery add, bulk (previously inflated), and stops double-counting
   idempotent re-imports. MCP `add_contact` and the manual add form now emit
   too (manual adds hit a new `/api/analytics/milestones` route for the
   server-side milestone check). Registry sources extended: `mcp`, `discovery`.
5. **email_sent.is_follow_up** — live cron path now labels follow-ups via
   `sendTrackedEmail`; dead `processFollowUps` (the only correctly-labeled but
   uncalled emitter) deleted.
6. **ai_draft_outcome** — carries `kind` (intro/write/follow_up); "discarded"
   now emitted when the compose modal closes with an unsent AI draft;
   follow-up edited outcomes carry a client-computed `edit_ratio`; unused
   `suggestion` kind removed from the registry.
7. **transcript_processed** — moved after the work in all 3 routes (failures
   no longer count as processed).
8. **api_error cron coverage** — new `withCronGuard` wraps all 5 QStash cron
   routes; crashes emit `api_error` under `system:cron`.
9. **mcp_tool_called** — awaited so serverless remote-MCP captures aren't
   dropped at lambda freeze.
10. **quick_capture_used** — fires on successful save, not modal open.
11. **Connect CTA clicks** — sent via `sendBeacon` (`trackBeforeNavigate`) so
    the full-page OAuth navigation can't drop them.

Migration: `20260710220000_email_messages_ai_assisted.sql` (apply on merge).

## Non-goals

- No change to the Activation funnel definition — it is correct going forward.
- No retroactive fake `gmail_connected` events; person properties are the
  source of truth for state, events remain the source of truth for transitions.
