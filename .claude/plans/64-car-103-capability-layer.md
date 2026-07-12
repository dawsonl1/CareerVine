# Plan 64 — CAR-103: Tier capability layer (Phase 0 foundation)

Part of CAR-101, **blocks CAR-102**. Build the entitlement primitive that lets the free "Outreach" and paid "Inbox" experiences stay **isolated** (a free-only change can't break paid) while **sharing** common code (shared work written once), and makes tier changes a **one-file edit**. This is pure foundation: it ships with **zero user-visible change** — the actual free/paid flip is CAR-102, made trivial and safe by what we build here.

> Verified by a 3-agent read-only audit of `careervine/src` (server entitlement patterns, client capability propagation, Gmail feature boundaries) on 2026-07-12. Findings are folded into "Current state" and each work item cites real files + lines.

## The idea in one paragraph (keycard model)

Every user carries a **keycard**: a set of *capabilities* (`mailbox:read`, `followups:auto`, …). Every gate in the app — a button, a page, a server route — asks **"does your card allow this?"**, never "are you free or paid?". Exactly **one place** (`capabilitiesFor`, the map) decides what goes on each card, derived from two flags on the user's Gmail connection. Add a tier, change what a tier includes, or grandfather a user → edit that one map (or flip one flag). Nothing else in the app knows tiers exist.

## Goals (Dawson, 2026-07-12 — approved)

- **Isolation:** divergent experiences live in separate, independently-loaded component trees; a free-only change can't reach paid code, and each tier's browser bundle excludes the other's shell.
- **DRY:** shared building blocks (compose, send, follow-up scheduler) live in one shared layer both experiences import.
- **Extensible:** capability-keyed, never tier-keyed. Tier→capability logic lives in one file.

## Current state (verified)

- **No capability/tier/plan/billing system exists.** Nearest gates: `isAdmin(user)` (role claim, `lib/admin.ts:15`) and connection booleans (`gmailConnected`/`calendarConnected`). The `users.ai_fallback_policy` column was *added then dropped* in favor of the `user_ai_access` table specifically to avoid "a second source of truth" (`20260709150000_drop_ai_fallback_policy.sql`) — the explicit precedent for our one-map rule.
- **Entitlement pattern to mirror** (bundle-access, ai-policy, scrape-controls, all CAR-5/26/25): a **service-role-only** flag; a small server read helper that **fails closed**; an admin route `withApiHandler({ requireAdmin: true })` that writes via the service client and calls `writeAudit`. `requireAdmin` gate lives at `lib/api-handler.ts:175-180` (reads `user.app_metadata.role`, 403 `{error:"Forbidden"}`). `writeAudit(service, {adminId, targetUserId, action, detail})` at `lib/admin.ts:40` is best-effort. `{count:"exact"}` is used only where affected-row count is load-bearing.
- **Client state pattern to mirror:** `useGmailConnection` (`hooks/use-gmail-connection.ts`) is a module-level `useSyncExternalStore` singleton — one shared `fetch("/api/gmail/connection")` (service client), derived boolean on the hook (`calendarConnected = data?.calendar_scopes_granted || false`). This is the template for the capability hook. Root provider tree: `app/layout.tsx:99-119` (AuthProvider → … → children).
- **No `next/dynamic` / `React.lazy` anywhere.** Today both branches are statically imported and picked at render time (`inbox/page.tsx:534` early-returns a Connect view). Per-tier lazy loading is a **net-new convention** we're introducing (standard Next.js; called out below).
- **Gmail feature is all `"use client"`; only the root layout is a server component.** The paid shell is one 1537-line component `app/inbox/page.tsx` mixing 4 live-mailbox tabs (inbox/sent/trash/hidden) with 3 DB-only tabs (drafts/scheduled/followups). Live-mailbox reads funnel through `lib/gmail.ts` and need `gmail.modify`; send needs only `gmail.send`; `/api/gmail/inbox` is already DB-only. Shared send/compose/follow-up primitives (`ComposeEmailModal`, `sendTrackedEmail`, `FollowUpModal`, `AvailabilityPicker`) need at most `gmail.send`.
- **`gmail_connections`** (CAR-27, `20260710100000_lock_down_gmail_connection_tokens.sql`) is locked to **column-grants**: `authenticated` can read only `(id, user_id, gmail_address, last_gmail_sync_at, created_at)`; everything else is service-role only. **A newly added column is invisible to the browser client by default** — no GRANT change needed, and the resolver must run server-side with the service client.
- **`oauth-helpers.ts:104` deletes the `gmail_connections` row on token revocation** (`invalid_grant`). Relevant to where the paid flag lives (see Decisions).

## Capability set (Phase 0) — the single source of truth

`type Capability = "mailbox:read" | "mailbox:modify" | "drafts:gmail" | "followups:auto" | "inbox:premium"`

Derived from two flags on the user's `gmail_connections` row:

| Capability | Gates (consumed in CAR-102) | Predicate (Phase 0) |
|---|---|---|
| `mailbox:read` | read live mailbox: inbox/sent/trash/hidden tabs, body-expand (`getFullMessage`), labels, `?contactId=` sync, full sync | `modifyScopeGranted` |
| `mailbox:modify` | mailbox actions: mark-read, trash/untrash, move/label | `modifyScopeGranted` |
| `drafts:gmail` | real Gmail drafts (`drafts.create`) | `modifyScopeGranted` |
| `followups:auto` | cron auto reply-detection + bounce-cancel | `automaticFeaturesEnabled && modifyScopeGranted` |
| `inbox:premium` | render premium Inbox shell (else Outreach) | `modifyScopeGranted` |

- All modify-gated capabilities share one predicate today but stay **semantically distinct** so a future tier (e.g. read-only) can diverge them by editing this map alone.
- **Fail closed:** on any resolve error, or no connection row, → empty set (free). Denying a real paid user transiently is the safe direction; matches every existing helper.
- **`inbox:premium = modifyScopeGranted` is deliberately behavior-preserving for Phase 0:** every current connection has `modify_scope_granted = true` (backfill), so everyone keeps the Inbox → zero change. **CAR-102 refines this predicate** (to the entitlement, plus down-scoping the 2 friend accounts to free) — a one-line edit in this map, which is the whole point.

## Work items (ordered, independently testable slices)

### 1. Migration + types — entitlement columns
`supabase/migrations/20260712020000_gmail_entitlement_columns.sql`:
```sql
ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS automatic_features_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS modify_scope_granted boolean NOT NULL DEFAULT true;  -- existing rows all hold modify
ALTER TABLE public.gmail_connections
  ALTER COLUMN modify_scope_granted SET DEFAULT false;                          -- future connects → sensitive-only
```
- No GRANT change — both columns fall outside CAR-27's `authenticated` column grant, so they're service-role-only automatically. **Verify** no `select("*")` on `gmail_connections` runs through a browser/`authenticated` client (resolver + admin use the service client; `queries.ts:1705` selects an explicit safe column list — confirm it's untouched).
- Regenerate `database.types.ts` (`supabase gen types`).

### 2. Capability model (the map) — `src/lib/capabilities/`
- `types.ts`: the `Capability` union + `EntitlementFlags` type.
- `map.ts`: `capabilitiesFor(flags: EntitlementFlags): Set<Capability>` — **the only place tier→capability logic lives** (the table above). Pure function, trivially unit-testable.
- `index.ts`: re-exports.

### 3. Server resolver — `src/lib/capabilities/resolve.ts`
`resolveCapabilities(userId): Promise<Set<Capability>>` — service client, reads `automatic_features_enabled, modify_scope_granted` from `gmail_connections` via `.maybeSingle()`, passes to `capabilitiesFor`, **fails closed** (empty set on error/no row). Mirrors `getApifyControls`/`resolveSharedAccess`. Optional 60s cache later; not required for Phase 0.

### 4. Server gate — generalize `requireAdmin`
In `lib/api-handler.ts`, add option `requireCapability?: Capability`. After auth, resolve the user's capabilities and 403 `{error:"Forbidden", capability}` if absent. Keep `requireAdmin` exactly as-is (widely used). **Do not apply `requireCapability` to any existing route in CAR-103** — it's the tool CAR-102 uses to 403 paid-only routes. Adding the option changes no behavior.

### 5. Client mirror — provider + hook + boundary
- `src/app/api/capabilities/route.ts`: `GET` via `withApiHandler` → `{ capabilities: Capability[] }` (resolver output as an array). Service-side resolution means the client never sees raw flags (sidesteps the CAR-27 column lock entirely).
- `src/components/capabilities-provider.tsx`: `CapabilitiesProvider` — same `useSyncExternalStore`/context shape as `useGmailConnection`; one shared fetch of `/api/capabilities`, gated on `useAuth().user`. Mounted **inside** `AuthProvider` in `app/layout.tsx`.
- `src/hooks/use-capabilities.ts`: `useCapabilities()` → `{ can(cap): boolean, capabilities, loading, refresh }`.
- `src/components/capable.tsx`: `<Capable capability fallback?>` — renders children only if `can(capability)`; the declarative UI gate CAR-102 wraps paid-only controls in.

### 6. Shell seam + dynamic loading (the branch point)
- **Relocate, don't carve.** Move the current inbox component out of `app/inbox/page.tsx` into `src/components/email/inbox/inbox-shell.tsx` as `InboxShell` (pure relocation: `"use client"` + code move, fix any relative imports; `@/` absolute imports are unaffected; no logic changes). This makes the paid shell its own dynamically-importable chunk so a free user's bundle excludes it.
- `src/components/email/outreach/outreach-shell.tsx`: `OutreachShell` — **minimal placeholder** for Phase 0 (clean "Outreach" screen, clearly the seam CAR-102 fills with the real sent/scheduled/follow-up portal). Kept deliberately small; no scope bleed into CAR-102's UX.
- `src/components/email/email-experience.tsx`: `EmailExperience` — reads `useCapabilities()`, shows a skeleton while `loading`, then **dynamically imports** (`next/dynamic`) either `InboxShell` (`can("inbox:premium")`) or `OutreachShell`. Never renders the wrong shell (no Inbox↔Outreach flicker).
- `app/inbox/page.tsx`: thin route → `<EmailExperience />`.
- `src/components/email/shared/`: created as the home for shared primitives. **Do not force extraction now** — the compose/send/follow-up stack is already shared (mounted globally in `layout.tsx`); bulk extraction is demand-driven in CAR-102 as the real Outreach shell needs pieces. Establishing the location is the Phase 0 deliverable.
- Because everyone has `inbox:premium` in Phase 0, prod still shows the Inbox for everyone; the only visible delta is a brief skeleton on first `/inbox` load. **Browser smoke-test the Inbox after the move** (rule 13 — relocation of a large surface).

### 7. Admin toggle (grant automatic features)
- `src/app/api/admin/users/[id]/automatic-features/route.ts`: `PATCH`, `withApiHandler({ requireAdmin: true })`, service client. **Verify a `gmail_connections` row exists** for the target (404 "no Gmail connection" if not — unlike `scrape-controls`, which writes the always-present `users` row). `.update({ automatic_features_enabled }, { count: "exact" })` and assert `count === 1` (rule 17 — a silent 0-row update reads as false success). `writeAudit({ action: "set_automatic_features", targetUserId, detail })`.
- Detail plumbing: add `automaticFeaturesEnabled` + `modifyScopeGranted` to `AdminUserDetail` via `shapeAdminUser` (`lib/admin-users.ts:87`), sourced from a `gmail_connections` query added to the detail GET route (`api/admin/users/[id]/route.ts`).
- `src/components/admin/automatic-features-section.tsx`: `Toggle`-based card (mirror `scraping-section.tsx` / optimistic-with-rollback like `bundle-access-list.tsx`), slotted into `app/admin/users/[id]/page.tsx:91-101`. Three states: **on** / **"entitled, awaiting reconnect"** (`enabled && !modifyScopeGranted`) / **"no Gmail connected"** (no row → disabled).
- Built now (not CAR-102) so the owner can pre-mark his 4 accounts before CAR-102's scope flip; the flag is inert until CAR-102 reads it, so building it here changes nothing.

### 8. Docs / README
- **No `docs.careervine.app` change** (rule 34): CAR-103 has no user-visible behavior change and the toggle is admin-only. Re-confirm at PR time. CAR-102 owns the user-facing docs updates.

## Tests (Vitest, from `careervine/`; rules 3–4)
- `capabilitiesFor`: each of the 4 flag combinations → exact expected capability set (esp. `followups:auto` requires *both* flags; no-flags → empty).
- `resolveCapabilities`: reads flags → correct set; missing row → empty; DB error → empty (fail-closed).
- `withApiHandler({ requireCapability })`: allows when present, 403 when absent; `requireAdmin` unchanged.
- Admin route: `requireAdmin` gate; 404 when no `gmail_connections` row; `count===1` guard; `writeAudit` called.
- `EmailExperience`: renders `InboxShell` when `can("inbox:premium")`, `OutreachShell` otherwise, skeleton while loading (mock `useCapabilities`).
- Full suite green + `npm run build` before PR.

## Migration & deploy
Claude applies the migration itself after merge (rule 27): validate by executing inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` against prod (rule 32), then `supabase db push`. Safe to land early — the columns' defaults keep every existing user behaviorally identical (all `modify_scope_granted = true`; `automatic_features_enabled = false` but nothing consumes it destructively until CAR-102). Merge → prod deploy shows no user-visible change.

## Decisions / risks
- **Zero-behavior-change is the acceptance bar.** Nothing existing consults capabilities in CAR-103; the only new consumers are the shell branch (`inbox:premium` true for all → Inbox for all) and the admin toggle (writes an inert flag). Verify by: full test suite, build, and an Inbox browser smoke-test post-relocation.
- **Paid flag on `gmail_connections` vs a durable user-level store.** `automatic_features_enabled` lives on `gmail_connections` (matches the CAR-101/102 decision; the resolver already reads that table). Risk: `oauth-helpers.ts:104` **deletes the row on token revocation**, which would drop the entitlement. Accepted for Phase 0/1 — paid users are only the owner's own 4 accounts (self-healing: re-toggle). **Phase 2 (real payments) should move the entitlement to a durable user-level store** (like `user_ai_access`) or re-apply it on reconnect. Flagged, not silently chosen.
- **New convention:** `next/dynamic` for the two shells (no prior precedent). Standard Next.js; documented here so it's a deliberate pattern, not a one-off.
- **`inbox:premium` predicate + friend down-scoping = CAR-102.** Phase 0 keys the shell on `modify_scope_granted` (behavior-preserving). CAR-102 refines the map to the entitlement and moves the 2 existing modify-holding friend accounts (Mark, Weston) to free — a one-file map edit plus the scope/token handling, owned there.
- **Naming collision:** a `/outreach` route already exists (the CAR-88 company-stepping compose flow), unrelated to the free-tier Outreach *portal*. Not a CAR-103 blocker; CAR-102 resolves naming/routing when it builds the portal.

## Out of scope (CAR-102 and later)
Flipping default scopes to sensitive-only; the callback id_token email + persisting `modify_scope_granted`; building the real Outreach portal; confirm-to-send follow-ups, nudges/expiry, badge; wiring `requireCapability` onto paid-only routes; the cron `followups:auto` gate; MCP tool adaptation; onboarding; user-facing docs. Payments, reconnect/incremental-auth, durable entitlement store, CASA = Phase 2. Recipient threading = CAR-104.
