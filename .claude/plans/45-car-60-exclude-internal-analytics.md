# CAR-60 — Exclude Dawson's internal accounts from PostHog

## Approach — two layers

1. **Stop capture at the source** (new events never ingested):
   - `src/lib/analytics/internal.ts`: `isInternalUser(userId)` reads the
     comma-separated `NEXT_PUBLIC_ANALYTICS_INTERNAL_USER_IDS` env var
     (NEXT_PUBLIC so the check works in both the browser bundle and server).
   - Client (`analytics/client.tsx`): when AnalyticsProvider identifies an
     internal user → `posthog.opt_out_capturing()` (kills curated events,
     autocapture, pageviews, and session replay in one switch); opt back in
     when a non-internal user is identified on the same device.
   - Server (`analytics/server.ts`): `trackServer()` returns early for
     internal user ids — covers API routes, cron sends, and both MCP servers.
   - Extension (`chrome-extension`): same id list in the env config;
     `trackEvent` no-ops when the logged-in user is internal.

2. **Hide historical events** (PostHog-side, no deploy needed):
   - `$set is_internal: true` on the five persons.
   - Project `test_account_filters` = `person.is_internal != true`,
     `test_account_filters_default_checked: true` so every insight (existing
     and new) excludes them by default.

## Internal ids (initial value of the env var)

63198da1 (dawsonlpitcher@gmail.com), d24b6d9b (dawsonl1@byu.edu),
296266b9 (pitcherdawson12@gmail.com), b376e8af (dawson@careervine.app),
dae9cb35 (car50-smoke-test). Adding a future test account = append to the
Vercel env var + $set is_internal, no code change.

## Ops (Claude-owned)

- Vercel env `NEXT_PUBLIC_ANALYTICS_INTERNAL_USER_IDS` set BEFORE merge so
  the merge-triggered deploy picks it up.
- PostHog person props + project filter via API immediately.
- Extension list ships with its next `build-prod.sh` package.

## Tests

- `isInternalUser` parsing (empty/unset var, whitespace, match/no-match).
- `trackServer` no-op for internal ids.
