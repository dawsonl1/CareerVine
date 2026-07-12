# Plan 64 — CAR-103: Tier capability layer (Phase 0 foundation)

Part of CAR-101, **blocks CAR-102**. Build the entitlement primitive that lets the free "Outreach" and paid "Inbox" experiences stay **isolated** (a free-only change can't break paid) while **sharing** common code (shared work written once), and makes tier changes a **one-file edit**. This is pure foundation: it ships with **zero user-visible change** — the actual free/paid flip is CAR-102, made trivial and safe by what we build here.

> **v2 — audit-corrected (2026-07-12).** A 4-agent adversarial audit (data layer, Inbox relocation, admin/handler, client/test) hardened this plan. Material changes from v1: **(1)** migration keeps `modify_scope_granted DEFAULT true` in Phase 0 and moves the flip-to-`false` into CAR-102 (else a new connect in the CAR-103→CAR-102 window defaults false while still granting modify → lands on the empty Outreach stub, breaking zero-change); **(2)** the client layer is a **module store** (clone `useGmailConnection`), not a mounted provider — v1 conflated the two; **(3)** `shapeAdminUser` has a **second call site** (the admin user-LIST route) + ~11 tests, so the new arg must be **optional** or the build breaks; **(4)** `requireCapability` needs the `(user as User|null)?.id` null-guard or an `authOptional` route 500s; **(5)** don't regenerate `database.types.ts` (hand-maintained, stale, clients untyped) — hand-add the two columns; **(6)** test files need the `// @vitest-environment jsdom` docblock and raw DOM asserts (jest-dom matchers aren't wired). Confirmed-correct items are marked ✓.
>
> **v3 — review-corrected (2026-07-12).** The 4-agent `/deep-review-pr` found the shell branch keyed on the *absence* of `inbox:premium`, so an empty capability set (unconnected user, transient `/api/capabilities` error, or the deploy→migration window) routed real users to the non-functional Outreach stub instead of the Inbox. Fix (supersedes work item 6 + the capability table below): added a positive `outreach:portal` capability granted to **nobody in Phase 0**, and defaulted `EmailExperience` to the **Inbox** shell — Outreach renders only on that positive grant, so unconnected users keep the Inbox's Connect-Gmail prompt and every empty-set state falls through to the Inbox. **Also apply the additive migration BEFORE the code deploys** to avoid the same window. **CAR-102 must grant `outreach:portal`** to confirmed free users — a modify-less free user resolves to an empty set, so "free" needs a positive grant, not the absence of premium.

## The idea in one paragraph (keycard model)

Every user carries a **keycard**: a set of *capabilities* (`mailbox:read`, `followups:auto`, …). Every gate in the app — a button, a page, a server route — asks **"does your card allow this?"**, never "are you free or paid?". Exactly **one place** (`capabilitiesFor`, the map) decides what goes on each card, derived from two flags on the user's Gmail connection. Add a tier, change what a tier includes, or grandfather a user → edit that one map (or flip one flag). Nothing else in the app knows tiers exist.

## Goals (Dawson, 2026-07-12 — approved)

- **Isolation:** divergent experiences live in separate, independently-loaded component trees; a free-only change can't reach paid code, and each tier's browser bundle excludes the other's shell.
- **DRY:** shared building blocks (compose, send, follow-up scheduler) live in one shared layer both experiences import.
- **Extensible:** capability-keyed, never tier-keyed. Tier→capability logic lives in one file.

## Current state (verified by audit)

- **No capability/tier/plan/billing system exists** and **no name collisions** — `capabilit*`, `Capable`, `EmailExperience`, `InboxShell`, `OutreachShell` are all free ✓. Nearest gates: `isAdmin(user)` (`lib/admin.ts:15`) and connection booleans. `users.ai_fallback_policy` was *added then dropped* for `user_ai_access` to avoid "a second source of truth" (`20260709150000_drop_ai_fallback_policy.sql`) — the precedent for our one-map rule.
- **Entitlement pattern to mirror** (bundle-access, ai-policy, scrape-controls): a **service-role-only** flag; a read helper that **fails closed** (`getApifyControls`, `resolveSharedAccess(userId)` at `lib/openai.ts:242`); an admin route `withApiHandler({ requireAdmin: true })` that writes via the service client + `writeAudit(service, {adminId, targetUserId, action, detail})` (`lib/admin.ts:40`). `requireAdmin` gate: `lib/api-handler.ts:175-180`.
- **`gmail_connections` is CAR-27-locked to explicit column-grants** ✓ (`20260710100000...:18-20`): `REVOKE ALL … FROM anon, authenticated; GRANT SELECT (id, user_id, gmail_address, last_gmail_sync_at, created_at) TO authenticated`. PG column grants **don't auto-extend to new columns**, so the two new flags are unreadable by the browser client — but a `SELECT *` via that client would **error** ("permission denied"), not silently hide. **No `select("*")` on `gmail_connections` exists** ✓; the one browser read (`queries.ts:1706` `getGmailConnection`) uses an explicit 4-column list inside the grant. `user_id` is `UNIQUE` ✓ (`20260217060000...:14`) → `.maybeSingle()`/`onConflict:"user_id"` valid. No triggers, no column-list RLS ✓.
- **Flags survive reconnect/refresh** ✓: the callback upsert and the refresh update are partial → `ON CONFLICT DO UPDATE SET <listed cols>` leaves the flags untouched. Only the revoked-token branch (`oauth-helpers.ts:104`) deletes the row (intended). **But nothing populates `modify_scope_granted` from granted scopes** — that wiring is CAR-102's callback change (mirror `calendar_scopes_granted`); in Phase 0 the column's `DEFAULT true` is correct because every connect still grants modify.
- **`database.types.ts` is hand-maintained + already stale, and no client is typed `<Database>`** (`service-client.ts:28`, `browser-client.ts:19` call `createClient` untyped) — so `.from("gmail_connections")` is `any`. Adding columns needs no type change to compile; do **not** run `supabase gen types` (would pull in unrelated drift). Hand-add the two columns for consistency.
- **Client state pattern:** `useGmailConnection` (`hooks/use-gmail-connection.ts`) is a **module-level `useSyncExternalStore` singleton** (not a Context/provider): one shared `fetch("/api/gmail/connection")`, lazy-inits when `useAuth().user` lands, derived boolean on the hook. `withApiHandler` GET returns a **plain object** (wrapped by `jsonResponse`→`NextResponse.json`) and **requires auth by default** (401 if unauthed) ✓.
- **Inbox is one clean-to-relocate 1536-line client component** (`app/inbox/page.tsx`): `"use client"`, only export is `export default function InboxPage()` (`:61`), **no route config/metadata**, **no `useSearchParams`/`usePathname`** (only `useRouter`, needs no Suspense), **zero relative imports**, **no external importers** ✓. Providers (`useAuth`, `useCompose`) are mounted app-wide in the root layout, so it renders correctly wherever placed.
- **Component-test harness exists** ✓ (`@testing-library/react`, `jsdom` in `package.json`) but global Vitest env is `node` (`vitest.config.ts:6`) — DOM tests opt in per-file via a first-line `// @vitest-environment jsdom` docblock, and **jest-dom matchers aren't wired** (`setup.ts` empty) so assert with `getByText`/`queryByText`, not `.toBeInTheDocument()`. The `vi.mock("@/components/auth-provider", …)` pattern (`use-gmail-connection.test.tsx`) is the template for mocking capabilities.

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

- Modify-gated capabilities share one predicate today but stay **semantically distinct** so a future tier can diverge them by editing this map alone.
- **Fail closed:** any resolve error / no row → empty set (free). Denying a real paid user transiently is the safe direction; matches every existing helper.
- **Behavior-preserving in Phase 0:** the column defaults to `true` and every connect still grants modify, so *every* user (existing and new-in-window) has `modify_scope_granted = true` → `inbox:premium` true → everyone keeps the Inbox → zero change. **CAR-102 refines this predicate** (to the entitlement, + down-scoping the 2 friend accounts) — a one-line map edit.

## Work items (ordered, independently testable slices)

### 1. Migration + types — entitlement columns
`supabase/migrations/20260712020000_gmail_entitlement_columns.sql` (repo-root `supabase/migrations/`):
```sql
ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS automatic_features_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.gmail_connections
  ADD COLUMN IF NOT EXISTS modify_scope_granted boolean NOT NULL DEFAULT true;  -- every current + in-window connect holds modify
```
- **No `SET DEFAULT false` here** (moved to CAR-102). Rationale: CAR-103 doesn't drop the `gmail.modify` request, so every new connect in the CAR-103→CAR-102 window genuinely holds modify; `DEFAULT true` keeps the flag truthful and keeps those users on the Inbox. CAR-102 flips the default to `false` in the *same* change that drops the scope and teaches the callback to persist `modify_scope_granted` from granted scopes.
- No GRANT change — new columns fall outside CAR-27's `authenticated` column grant, so they're service-role-only automatically. (Verified: no `select("*")` on the table; `queries.ts:1706` uses an explicit list — leave it untouched.)
- **Do not run `supabase gen types`** — hand-add `automatic_features_enabled` + `modify_scope_granted` to the `gmail_connections` Row in `lib/database.types.ts` (cosmetic; clients are untyped, so no typecheck impact either way).

### 2. Capability model (the map) — `src/lib/capabilities/`
- `types.ts`: `Capability` union + `EntitlementFlags` type.
- `map.ts`: `capabilitiesFor(flags: EntitlementFlags): Set<Capability>` — **the only place tier→capability logic lives** (the table above). Pure, unit-testable.
- `index.ts`: re-exports.

### 3. Server resolver — `src/lib/capabilities/resolve.ts`
`resolveCapabilities(userId): Promise<Set<Capability>>` — service client, `.select("automatic_features_enabled, modify_scope_granted").eq("user_id", userId).maybeSingle()`, → `capabilitiesFor`, **fails closed** (empty set on error/no row). Mirrors `getApifyControls`/`resolveSharedAccess`.

### 4. Server gate — generalize `requireAdmin`
In `lib/api-handler.ts`, add option `requireCapability?: Capability`, enforced immediately after the `requireAdmin` block (`:175-180`), before params/body parse. **Null-guard like the existing gates** (`(user as User | null)?.id`): if no authenticated user, treat as no capability → 403, never `resolveCapabilities(undefined)` (which would 500 on an `authOptional` route). `resolveCapabilities` uses its own service client, so it works on session + extension-auth paths alike. 403 `{error:"Forbidden", capability}`. Keep `requireAdmin` unchanged. **Apply `requireCapability` to no existing route in CAR-103** (it's CAR-102's tool) — adding the option changes no behavior. Precedent for an awaited post-auth gate that short-circuits: the rate-limit block (`:188`).

### 5. Client mirror — store + hook + boundary (NOT a provider)
- `src/app/api/capabilities/route.ts`: `GET` via `withApiHandler` → `return { capabilities: Capability[] }` (plain object; handler wraps it). Server-side resolution → the client never sees raw flags (sidesteps the CAR-27 lock).
- `src/hooks/use-capabilities.ts`: **clone the `use-gmail-connection.ts` module-singleton store** — one shared `fetch("/api/capabilities")` gated on `useAuth().user` (401 otherwise), `useSyncExternalStore`, `refresh()`, `invalidate…()`. `useCapabilities()` → `{ can(cap): boolean, capabilities: Set<Capability>, loading, refresh }`. **No provider, no `layout.tsx` mount** (a store needs neither — v1's "mount inside AuthProvider" was wrong).
- `src/components/capable.tsx`: `<Capable capability fallback?>` — renders children only if `can(capability)`; the declarative UI gate CAR-102 wraps paid-only controls in.

### 6. Shell seam + dynamic loading (net-new code — review/test as a feature, not a move)
- **Relocate the Inbox** from `app/inbox/page.tsx` to `src/components/email/inbox/inbox-shell.tsx`. The only real edits: `export default function InboxPage()` → `export function InboxShell()` (default→named + rename). Zero import-path fixups. No Suspense needed (no `useSearchParams`).
- `src/components/email/outreach/outreach-shell.tsx`: `OutreachShell` — **minimal placeholder** (clean "Outreach" screen; the seam CAR-102 fills). No scope bleed.
- `src/components/email/email-experience.tsx`: `EmailExperience` — reads `useCapabilities()`; **three explicit states**: `loading` → skeleton; `can("inbox:premium")` → `InboxShell`; else → `OutreachShell`. Both shells via `next/dynamic(() => import(...).then(m => m.InboxShell), { ssr: false })` (repo's first `next/dynamic` — deliberate new convention). Never renders the wrong shell (skeleton until resolved → no Inbox↔Outreach flash).
- `app/inbox/page.tsx`: thin route → `<EmailExperience />`.
- `src/components/email/shared/`: created as the home for shared primitives; **no forced extraction** (compose/send/follow-up is already shared via the global layout mount). Bulk extraction is demand-driven in CAR-102.
- Everyone has `inbox:premium` in Phase 0 → prod still shows the Inbox; only delta is a brief skeleton on first `/inbox` load. **Browser smoke-test the Inbox after the move** (rule 13).

### 7. Admin toggle (grant automatic features)
- `src/app/api/admin/users/[id]/automatic-features/route.ts`: `PATCH`, `withApiHandler({ requireAdmin: true, schema })`, service client. Row-exists pre-check → 404 "No Gmail connection" (mirror `scrape-controls:35-41`). `.update({ automatic_features_enabled }, { count: "exact" })` + assert `count === 1` (rule 17). `writeAudit(service, { adminId: admin.id, targetUserId: id, action: "set_automatic_features", detail })` (full signature — `service` + `adminId` are required; `admin_audit_log.action` is free-text ✓).
- **Detail plumbing (audit-corrected):** add `automaticFeaturesEnabled` + `modifyScopeGranted` to `AdminUserDetail` (`lib/admin-users.ts:43`) and to `shapeAdminUser` as an **optional** trailing param `gmailConnection?: {…} | null` (defaults both false). Detail GET route (`api/admin/users/[id]/route.ts`) adds a 5th `gmail_connections` read to its `Promise.all` (`:30-48`, service client) and passes the row. **The user-LIST route (`api/admin/users/route.ts:87`) and the ~11 `admin-users.test.ts` calls pass nothing** → fields default false; the list doesn't render them, so it's inert (optional param → no build break, no test churn). Add a one-line comment there noting the fields are detail-only.
- `src/components/admin/automatic-features-section.tsx`: `Toggle`-based card, **await-then-reload** pattern like `scraping-section.tsx` (set `saving`, `await` PATCH, `onChanged()` refetch — NOT the optimistic `bundle-access-list` pattern; state derives from the parent's refetched `AdminUserDetail`). Slot after `ScrapingSection` in `app/admin/users/[id]/page.tsx:99` as `<AutomaticFeaturesSection user={user} onChanged={load} />` (sections receive the full `AdminUserDetail` ✓). Three states: **on** / **"entitled, awaiting reconnect"** (`enabled && !modifyScopeGranted`) / **"no Gmail connected"** (disabled).
- Built now so the owner can pre-mark his 4 accounts before CAR-102's scope flip; the flag is inert until CAR-102 reads it.

### 8. Docs / README
- **No `docs.careervine.app` change** (rule 34): no user-visible behavior change, toggle is admin-only. Re-confirm at PR. CAR-102 owns user-facing docs.

## Tests (Vitest, from `careervine/`; rules 3–4)
- `capabilitiesFor`: all 4 flag combos → exact set (`followups:auto` needs *both*; no flags → empty).
- `resolveCapabilities`: flags → set; missing row → empty; DB error → empty (fail-closed).
- `withApiHandler({ requireCapability })`: allow when present; 403 when absent; **null user → 403 not 500**; `requireAdmin` unchanged.
- Admin route: `requireAdmin` gate; 404 when no row; `count===1` guard; `writeAudit` args.
- `EmailExperience` (`// @vitest-environment jsdom` docblock; `getByText`/`queryByText` asserts; mock `useCapabilities`): renders skeleton while `loading`, `InboxShell` when `inbox:premium`, `OutreachShell` otherwise — **all three states**.
- Full suite green + `npm run build` before PR.

## Migration & deploy
Claude applies the migration after merge (rule 27): validate inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` against prod (rule 32), then `supabase db push`. `ADD COLUMN … DEFAULT <const>` is metadata-only on PG 11+ (no rewrite). Defaults keep every user behaviorally identical. Merge → prod deploy → no user-visible change.

## Decisions / risks
- **Zero-behavior-change is the acceptance bar.** Nothing existing consults capabilities; the only new consumers are the shell branch (`inbox:premium` true for all → Inbox for all) and the admin toggle (inert flag). Verify by: full suite, build, Inbox browser smoke-test.
- **Migration default stays `true` in Phase 0** (audit fix). Flipping to `false` before CAR-102 drops the scope + wires the callback would mis-default new in-window connects to free and strand them on the empty Outreach stub. The flip + callback persistence are one atomic CAR-102 change.
- **Paid flag on `gmail_connections` vs a durable user-level store.** Matches the CAR-101/102 decision; resolver reads one table. Risk: `oauth-helpers.ts:104` deletes the row on token revocation, dropping the entitlement. Accepted for Phase 0/1 (paid = owner's 4 accounts, self-healing re-toggle). **Phase 2 (payments) should move it to a durable user-level store** or re-apply on reconnect. Flagged, not silently chosen.
- **New convention:** `next/dynamic` for the two shells (no prior precedent). Standard Next.js; deliberate.
- **`inbox:premium` predicate + friend down-scoping = CAR-102.** Phase 0 keys on `modify_scope_granted` (behavior-preserving); CAR-102 refines the map + moves Mark/Weston to free.
- **Naming collision:** a `/outreach` route already exists (CAR-88 company-stepping compose flow), unrelated to the free-tier Outreach *portal*. Not a CAR-103 blocker; CAR-102 resolves naming/routing.

## Out of scope (CAR-102 and later)
Flipping default scopes to sensitive-only + `ALTER COLUMN modify_scope_granted SET DEFAULT false`; the callback id_token email + **persisting `modify_scope_granted` from granted scopes**; building the real Outreach portal; confirm-to-send follow-ups, nudges/expiry, badge; wiring `requireCapability` onto paid-only routes; the cron `followups:auto` gate; MCP tool adaptation; onboarding; user-facing docs. Payments, reconnect/incremental-auth, durable entitlement store, CASA = Phase 2. Recipient threading = CAR-104.
