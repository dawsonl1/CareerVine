# CAR-37 — Chrome extension public-readiness fixes

Deep review (2026-07-10) of `chrome-extension/` found bugs and polish items to fix
before opening the extension to users beyond Dawson. International/i18n findings
are **descoped** (English-only audience): `standardizeLocation`'s USA-append and
non-English LinkedIn section detection stay as-is.

## 1. Fix broken signup + add forgot-password links

**Web app:** add a real `/auth` route (`careervine/src/app/auth/page.tsx`) that
renders the existing `AuthForm`, honoring `?mode=signup|signin|reset` via
`initialMode`, and redirects to `/` when already signed in. This gives the
extension (and anything else) a stable deep-link; the landing page keeps its
state-toggle flow untouched.

**Extension:**
- popup `signupLink` → `https://www.careervine.app/auth?mode=signup` (config-aware
  via getConfig where practical; popup currently hardcodes — keep the prod URL,
  it only matters in prod).
- panel "Create an account" (`App.tsx`) → real `<a>` to
  `${webappBaseUrl}/auth?mode=signup`, target _blank.
- Add "Forgot password?" links to both sign-in forms → `/auth?mode=reset`.

## 2. Kill cross-tab profile bleed (per-tab state via bus, not global storage)

Today: background writes `latestProfile`/`latestPhotoUrl` to global
`chrome.storage.local`; every panel in every tab subscribes to storage changes →
tab A's scrape overwrites tab B's panel; Save then imports the wrong person.

Fix — make profile state flow tab-locally over the existing `__cv_bus`:
- `background.js handleParseProfile`: stop writing `latestProfile`/`latestPhotoUrl`;
  just return `profileData` in the response (it already does).
- `content.js scrapeCurrentProfile`: take `profileData` from the parse response,
  write it into `profileCache` (already keyed by profileId) with the photo URL,
  and `emit('profiledata', { profileData, photoUrl })` to its own panel.
- `tryLoadFromCache`: emit `cachedhit` with `photoUrl` from the cache entry
  instead of writing global storage.
- Panel (`App.tsx`): drop the `chrome.storage.onChanged` listener and the
  mount-time `getLatestProfile` call; consume `profiledata`/`cachedhit` events
  (both carry photoUrl). Photo state comes from events, not storage.
- Remove now-dead plumbing: `getLatestProfile` background action + storage writes,
  `latestProfile`/`latestPhotoUrl` cleanup calls become no-ops to keep logout
  cleanup simple (leave the `remove()` keys for stale installs).

## 3. Panel-ready handshake (fixes dbmatch race + first-open state)

- Panel emits `panel-ready` on mount after listeners attach.
- `content.js` listens: on `panel-ready`, run the current open-panel logic
  (DB check + cache try + optional auto-scrape) for the current profile.
  `checkProfileInDB` caches its *result* (`lastDbCheck = {profileId, contact}`)
  and re-emits on every panel-ready/openPanel instead of a fire-once guard.
- `openPanel()` keeps calling the same logic for the already-mounted case
  (panel-ready only fires once per mount; reopening the panel doesn't remount).

## 4. Single-flight token refresh (`background.js`)

Module-level `refreshPromise`; concurrent `getValidSession()` callers with an
expired token share one refresh. Cleared in `finally`.

## 5. Cap `cleanedText` server-side

`extensionParseProfileSchema`: `.max(60_000)` with a clear error message.
(Cleaned profile text is typically <15k chars.) No rate limiter in this pass —
no existing rate-limit infra and in-memory limits are useless on serverless;
noted on the ticket if it becomes a problem.

## 6. FAB only on profile pages

`content.js`: show/hide the FAB based on `linkedin.com/in/` in
`handleProfileNavigation` + init. Panel behavior unchanged (it already handles
`leftprofile`).

## 7. Persist panel edits to the profile cache

`handleSaveEdit` (App.tsx): after applying edits to state, update the
`profileCache` entry for the current profileId (panel shares the page URL).
Keep the original cache timestamp semantics simple: refresh timestamp on edit.

## 8. Popup version from manifest

`popup.js`: set `.app-version` text from `chrome.runtime.getManifest().version`;
drop the hardcoded "v3.0.0" in popup.html.

## 9. Dead code + stale docs

- `src/utils/api.js`: remove unused `importData` and `getLatestProfile`.
- `popup.js`: stop presenting company pages as importable (neutral state).
- `README.md`: remove company-scraping claim; align features with reality.
- `SETUP.md`: drop "What's Been Built" checkboxes + "Week 2–4" plan; keep
  quick start + troubleshooting.

## Verification

- `npm run test` from `careervine/` (existing suites + new tests below).
- New/updated tests: `extensionParseProfileSchema` max-length bound; `/auth`
  page mode handling if practical in existing test setup.
- Rebuild panel: `cd chrome-extension/panel-app && npm run build` (regenerates
  `src/content/panel-app/panel.js`); commit the bundle with the source.
- Manual smoke (Dawson or Claude via Chrome control): load unpacked, sign in,
  scrape a profile, two-tab scenario, existing-contact badge on first open.

## Out of scope

- International location display + non-English scraping (descoped).
- Rate limiting on parse-profile (no infra; schema cap covers the main exposure).
- Chrome Web Store listing assets (privacy policy URL, screenshots,
  permission justifications) — listing-time manual steps, tracked on CAR-37.
