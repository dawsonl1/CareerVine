# Plan 36 — Admin dashboard: granular Apify spend controls (CAR-25 scope)

**Branch:** `dawson/scrape-diff-cost-modeling-46fd91` (rides in PR #2 with the CAR-15 increment, per Dawson's one-branch instruction)
**Requested:** 2026-07-09 — "add the ability inside the manager dashboard to stop apify enrichment and diff analysis on select account and also a toggle all on or off at once ability … pretty granular control … so I can control how much apify money I'm spending."
**Fulfills:** the CAR-25 note recorded earlier this increment ("per-account toggle for auto-enrich when the dashboard gets built") — and generalizes it to *all* paid Apify activity.

## 1. Model

Two per-account booleans on `users`, following the `status` / `ai_fallback_policy` admin-column pattern from `20260709140000_admin_dashboard_foundation.sql`:

| Column | Default | Gates |
| --- | --- | --- |
| `apify_enrichment_enabled` | `true` | Every path that spends Apify money for that account: extension auto-enrich on save, daily cadence cron, manual Refresh, Find Email, LinkedIn resolver |
| `diff_analysis_enabled` | `true` | Change-event production from scrape ingests (diff engine + anniversary events). Snapshots and the data merge still happen — the account just stops generating change events |

Default `true` preserves current behavior for existing accounts; Dawson turns things off from the dashboard.

**Migration** `2026071X…_apify_account_controls.sql` (numbered after whatever main holds at build time — same-version collisions are silently skipped by `db push`):
- `ALTER TABLE users ADD COLUMN … NOT NULL DEFAULT true` ×2 + `COMMENT`s.
- Self-escalation guard: the foundation's column-grant model already blocks `authenticated` from updating unlisted columns; **also** extend the `users_update_own` WITH CHECK pinning to the two new columns (consistency with `status`/`ai_fallback_policy` — convention divergence otherwise).
- `database.types.ts`: add to `users` Row / Insert / Update.

## 2. Enforcement (service layer, central choke points)

New `careervine/src/lib/apify/account-controls.ts`:
- `getApifyControls(service, userId): Promise<{ enrichmentEnabled: boolean; diffEnabled: boolean }>` — single service-role read of the two columns. Fail-closed: on read error, treat both as **disabled** (consistent with the spend-integrity fail-closed convention).

Gate points (each returns/logs a typed `disabled_by_admin` outcome, no silent no-ops):
1. `triggerContactScrape` — covers manual Refresh + Find Email (and any future single-contact trigger).
2. `triggerEnrichOnSave` — extension save path.
3. `resolveContactLinkedin` — actor-B search spend.
4. `selectCadenceCandidates` — exclude contacts belonging to enrichment-disabled users at selection time so the cron never reserves spend for them.
5. `ingestScrapeRun` — when `diff_analysis_enabled=false`: still merge + snapshot + record cost, **skip** diff → change-event insertion.

Note: webhook ingest of an already-running run is never blocked (the money is spent; the data should land). Disabling enrichment stops *new* spend only.

## 3. Admin API

- `PATCH /api/admin/users/[id]/scrape-controls` — body `{ apify_enrichment_enabled?: boolean; diff_analysis_enabled?: boolean }` (≥1 key). Service-role update, 404 on unknown user, audit `set_scrape_controls` with the changed fields. Mirrors `ai-policy/route.ts`.
- `POST /api/admin/scrape-controls/bulk` — same body, applies to **all** users (`UPDATE users SET …`); returns affected count; audit `set_scrape_controls_all`. This is the "toggle all on/off at once".

Both behind `withApiHandler({ requireAdmin: true })`.

## 4. Admin UI

- **User detail page** (`/admin/users/[id]`): new `ScrapingSection` (`components/admin/scraping-section.tsx`) between AI and Contacts sections — two labeled toggles (Apify enrichment / Change-event analysis) with one-line explanations, plus the account's **current-month Apify spend** (from `scrape_runs` via a small admin endpoint or included in the detail payload) so the toggle sits next to the number it controls.
- **Users list page** (`/admin/users`): compact "Apify controls" card above the table — enabled-account counts (e.g. "enrichment on for 12/14 accounts") and four actions: enrichment all-on / all-off, diff all-on / all-off, each with a confirm step. Per-row badges only if they don't clutter (UX rule 5 — lean toward the counts + detail page rather than more table columns).
- `AdminUserListItem`/`AdminUserDetail` + `shapeAdminUser` + `PublicUserRow` gain the two flags.

## 5. Tests

- `shapeAdminUser` flag mapping.
- Gating: each trigger function returns `disabled_by_admin` when the flag is off; `ingestScrapeRun` skips diff but still snapshots when diff is off (extend existing scrape-service tests' mock pattern).
- Cadence exclusion of disabled users.
- Route validation (≥1 key required) + bulk affected-count, following `admin-actions.test.ts` conventions.

## 6. Order of work

1. Migration + types (apply to prod via `db push` when it lands on main, rule 27).
2. `account-controls.ts` + the five gates + tests.
3. Admin API routes + tests.
4. UI sections.
5. `npm run test`, `tsc`, build; commit/push to the branch; update CAR-25 + CAR-15 in Linear.
