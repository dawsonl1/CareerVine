# CAR-36 — Inline permission visibility + toggles on the admin users list

## Problem

Changing an account's permissions currently requires clicking into each user's detail page. Dawson wants to see and toggle each account's permissions directly from `/admin/users`.

## What counts as a "permission" here

Reversible, non-destructive grants only:

1. **Shared-AI fallback** (`shared` / `cutoff`) — single boolean, written via existing `PATCH /api/admin/users/[id]/ai-policy`.
2. **Bundle visibility** — per-bundle grant/hide/default, written via existing `PUT /api/admin/users/[id]/bundle-access`.

Suspend/reactivate, delete, and admin-role changes **stay on the detail page**: they're confirm-gated destructive actions (per the established policy: optimistic toggles for reversible actions, confirm modals for irreversible ones), not permission toggles.

## Design

### List API (`GET /api/admin/users`)

- Extend the response with a per-user bundle summary: `bundlesVisible` and `bundlesTotal` on `AdminUserListItem`.
- Computed in bulk — two extra queries total (not per-user): published `data_bundles (id, default_visible)` and `bundle_access_overrides (user_id, bundle_id, allowed)` for the listed user ids, folded through the existing `effectiveBundleVisibility` predicate.
- New pure helper in `lib/admin-bundles.ts` (e.g. `bundleVisibilityCount(bundles, overridesForUser)`) so the fold is unit-testable, mirroring the `shapeAdminUser` pattern.

### List row (`app/admin/users/page.tsx`)

Restructure each row from a whole-row `<Link>` to a row container:

- **Link area** (avatar, name, badges, email) still navigates to the detail page; chevron stays.
- **Permissions cluster** (right side, wraps below content on small screens instead of today's `hidden sm:flex`):
  - `KeyBadge` — read-only key state, unchanged.
  - **Shared AI** — labeled `Toggle` replacing the passive `PolicyBadge`. Optimistic write + rollback + toast (matches BundlesSection pattern).
  - **Bundles n/m** — chip-button showing `bundlesVisible/bundlesTotal`; click expands an inline panel under the row.
- **Inline bundle panel** — lazy-loads `GET .../bundle-access` on first expand; compact list of published bundles, each with the same `Toggle` + clear-override affordance and state chips as the detail page. Extract the reusable list from `components/admin/bundles-section.tsx` so the detail card and the row expander share one implementation (no logic fork).
- Hidden when `bundlesTotal === 0` (no published bundles).

### Files

- `careervine/src/lib/admin-users.ts` — extend `AdminUserListItem`.
- `careervine/src/lib/admin-bundles.ts` — add pure summary helper.
- `careervine/src/app/api/admin/users/route.ts` — bulk summary computation.
- `careervine/src/app/admin/users/page.tsx` — row restructure + controls.
- `careervine/src/components/admin/bundles-section.tsx` — extract shared `BundleAccessList`.
- `careervine/src/components/admin/user-badges.tsx` — retire `PolicyBadge` usage on the list (detail header keeps whatever it uses today).

## Non-goals

- No schema changes, no new API routes.
- No changes to detail-page behavior beyond the shared-list extraction.

## Tests (Vitest, from `careervine/`)

- Unit: bundle summary helper (defaults, grant override, deny override, no bundles).
- Route: `GET /api/admin/users` returns correct `bundlesVisible/bundlesTotal` (extend existing `admin-users` route test doubles).
- Update any list-page/API tests that assert the old response shape.

## Verification

- `npm run test` green from `careervine/`.
- `npm run build` green.
- Manual spot-check happens on Dawson's review (low-risk UI per rule 13); PR describes the interaction.
