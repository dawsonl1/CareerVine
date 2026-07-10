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

## Non-goals

- No change to the Activation funnel definition — it is correct going forward.
- No retroactive fake `gmail_connected` events; person properties are the
  source of truth for state, events remain the source of truth for transitions.
