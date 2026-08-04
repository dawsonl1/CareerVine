# CAR-75: Setup banner blinks every 5s during onboarding sync

## Problem

During the guided onboarding sync step, the "Complete your setup" banner (and anything else consuming the shared Gmail-connection store) blinks every 5 seconds.

`SyncProgressStep` in `careervine/src/components/onboarding/onboarding-flow.tsx` polls `refreshConnection()` on a 5s interval so the Connect Gmail/Calendar buttons flip to "connected" after the OAuth round-trip. `refresh()` in `careervine/src/hooks/use-gmail-connection.ts` sets the shared module-level store to `{ loading: true }` on every call. `SetupBanner` (`careervine/src/components/setup-banner.tsx:35`) returns `null` whenever `loading` is true, so each poll unmounts the banner until the refetch resolves — a visible blink behind the modal.

## Fix

Keep the poll (it is what makes the connect buttons flip after OAuth) but make `refresh()` a **silent background refresh**:

1. `refresh()` no longer sets `loading: true`. It just clears the memoized `fetchPromise` and refetches; consumers keep rendering current data and swap when new data lands. `loading` now means "initial load, no data yet" only.
2. The fetch error path no longer wipes `data` to `null` — it only clears `loading`. On initial load `data` is already `null` (identical behavior); on a background refresh a transient network error no longer makes connected integrations appear disconnected for a frame.
3. `invalidateGmailConnectionCache()` (disconnect flows) keeps its explicit wipe-and-reload behavior — the Settings disconnect path calls it before `refresh()`, so nothing there changes.

## Files

- `careervine/src/hooks/use-gmail-connection.ts` — the two store changes above.
- `careervine/src/__tests__/use-gmail-connection.test.ts` (new) — store-level tests: initial fetch sets data + loading false; `refresh()` keeps `loading` false and stale data visible while in flight, then swaps in new data; failed background refresh preserves existing data; `invalidateGmailConnectionCache()` still wipes.

## Verification

`npm run test` and `npm run build` from `careervine/`.
