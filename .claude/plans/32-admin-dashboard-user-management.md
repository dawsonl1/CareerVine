# 32 — Admin Dashboard & User Management

**Linear:** Project "Admin Dashboard & User Management" · anchor [CAR-25](https://linear.app/career-vine/issue/CAR-25)
**Status:** Detailed plan — ready to build pending 4 decisions (§10)
**Scope:** CAR-25 (core + foundation), CAR-23 (manage accounts), CAR-21 (contact injection)
**Depends on:** CAR-16 (BYO OpenAI keys — Done), CAR-5 (Data bundles — In Progress)

> **Out of scope** (separate standalone issues, not this project): CAR-20 usage logging, CAR-22 analytics dashboards, CAR-26 graceful AI-failure UX.

---

## 1. Goal

A single admin-only surface at `/admin` where the operator (Dawson) controls individual user accounts:

- **Bundle access** — per account, per bundle: whether the user can even see a bundle as subscribable (CAR-25).
- **AI key policy** — per account: when the user's own OpenAI key is missing/invalid/spent, fall back to the shared CareerVine key or cut AI off (CAR-25).
- **Account lifecycle** — edit profile, reset/set password, suspend/reactivate (CAR-23).
- **Contact control** — inject/remove contacts in any account (CAR-21).

## 2. The core problem this solves first

The app has **no admin concept**. Every route and row is scoped to the logged-in user via `auth.uid()` RLS. Nothing marks an account as privileged, nothing gates cross-account action, and there is no `/admin` surface. CAR-25 builds that foundation (Phase 0); CAR-23 and CAR-21 are panels on top of it.

## 3. Authorization design (load-bearing)

**Admin claim lives in Supabase `auth.users.app_metadata.role`.** It is writable only by the service role / Supabase admin API (a user cannot self-promote), and it rides in the JWT so it's checkable in API routes and RLS with no extra query. An `is_admin` boolean on `public.users` would be self-editable through the existing `UPDATE ... USING (id = auth.uid())` policy — a privilege-escalation hole — so we do **not** use that.

**Enforcement:** a new `requireAdmin: true` option on `withApiHandler` (`careervine/src/lib/api-handler.ts`). Admin API routes live under `careervine/src/app/api/admin/**` and, once past the gate, use the **service-role client** (`createSupabaseServiceClient`) for cross-account reads/writes. Every admin mutation appends an `admin_audit_log` row via one helper. This is deliberately different from the existing `BUNDLE_ADMIN_TOKEN` machine route (`api/admin/bundles/publish`), which authenticates a *script* by shared secret, not a *human* by session.

**UI:** an `/admin` route-group whose layout server-checks the claim and redirects non-admins; the nav entry renders only for admins. The API gate is the real boundary; hiding the UI is defense-in-depth.

---

## 4. Integration points (verified against current code)

| Concern | File / symbol |
|---|---|
| API gate | `careervine/src/lib/api-handler.ts` → `withApiHandler(config)`, `RouteConfig` options, `HandlerContext { request, user, supabase, body, query, params }`, `ApiError` |
| Service client | `careervine/src/lib/supabase/service-client.ts` → `createSupabaseServiceClient()` |
| Server (cookie) client | `careervine/src/lib/supabase/server-client.ts` → `createSupabaseServerClient()` (already used inside `withApiHandler`) |
| AI resolver | `careervine/src/lib/openai.ts` → `getOpenAIForUser(userId)`, `runWithOpenAIFallback(userId, fn)`, `createOpenAIRunner(userId)`, `getAppOpenAIClient()`, `ResolvedOpenAI` |
| Bundle list (to filter) | inline query in `careervine/src/components/settings/data-subscriptions-section.tsx` `load()` (`from("data_bundles").select(...)`) |
| Bundle routes | `careervine/src/app/api/bundles/{subscribe,unsubscribe,apply}/route.ts` |
| Nav | `careervine/src/components/navigation.tsx` → `navItems` array, already reads `useAuth()` |
| Auth/session | `careervine/src/components/auth-provider.tsx` → `signIn` (lines ~110-122), `onAuthStateChange` (~66-71) — sign-in gate insertion point |
| Profile update | `account-section.tsx` + `queries.ts` → `updateUserProfile(userId, updates)`, `getUserProfile(userId)`; password via `supabase.auth.updateUser({ password })` |
| Migrations | `supabase/migrations/`, format `YYYYMMDDHHMMSS_snake.sql`; match `20260709120000_create_user_api_keys.sql` style (service-role-only RLS, revoke anon/authenticated) |

---

## 5. Data model changes

One migration, `supabase/migrations/<ts>_admin_dashboard_foundation.sql`:

```sql
-- Account status (CAR-23). Read-only to the user; only service role writes it.
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended'));

-- Per-account AI fallback policy (CAR-25).
ALTER TABLE users ADD COLUMN ai_fallback_policy text NOT NULL DEFAULT 'cutoff'
  CHECK (ai_fallback_policy IN ('cutoff','shared'));

-- Per-bundle default visibility + per-(user,bundle) override (CAR-25).
-- Decision: bundles are HIDDEN until granted, so default_visible defaults to false.
-- (Set a bundle's default_visible=true to make it broadly public.)
ALTER TABLE data_bundles ADD COLUMN default_visible boolean NOT NULL DEFAULT false;

CREATE TABLE bundle_access_overrides (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bundle_id  uuid NOT NULL REFERENCES data_bundles(id) ON DELETE CASCADE,
  allowed    boolean NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bundle_id)
);
ALTER TABLE bundle_access_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY bundle_access_overrides_service_role_all ON bundle_access_overrides
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON bundle_access_overrides FROM anon, authenticated;

-- Admin action audit trail.
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid NOT NULL REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  action  text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_audit_log_service_role_all ON admin_audit_log
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON admin_audit_log FROM anon, authenticated;
```

**Critical:** the existing `users` UPDATE policy must **not** let a user change `status` or any new privileged column. Add a guard so authenticated self-updates can only touch profile fields:

```sql
-- Replace the users self-update policy with a column-safe version.
DROP POLICY IF EXISTS users_update_own ON users;   -- (match the real policy name in 20260214065459_add_rls_policies.sql)
CREATE POLICY users_update_own ON users FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND status = (SELECT status FROM users WHERE id = auth.uid())
    AND ai_fallback_policy = (SELECT ai_fallback_policy FROM users WHERE id = auth.uid())
  );
```

*(Verify the exact existing policy name before writing; the sub-select pattern pins privileged columns to their current value so a self-update can't change them. Covered by an RLS regression test in §9.)*

Regenerate types afterward: `npx supabase gen types typescript` → `careervine/src/lib/database.types.ts`.

---

## 6. Phase 0 — Admin foundation (in CAR-25)

**Goal:** an admin identity, a gate, the shell, and the audit helper. Nothing user-visible changes for non-admins.

1. **Migration** (§5) — apply locally, dry-run `supabase db push` first (rule 15).
2. **Bootstrap admin** — `careervine/scripts/grant-admin.mjs` (mirrors `publish-bundle.mjs` style): takes an email, uses the service client's `auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })`. Run once for Dawson. Documented in the script header.
3. **Gate** — extend `RouteConfig` in `api-handler.ts` with `requireAdmin?: boolean`. After the user is resolved (~line 111), if `requireAdmin` and `user?.app_metadata?.role !== 'admin'` → return 403. Keep it composable with `schema`/`querySchema`.
4. **Admin helpers** — `careervine/src/lib/admin.ts`:
   - `isAdmin(user): boolean` (reads `app_metadata.role`).
   - `writeAudit(service, { adminId, targetUserId, action, detail })` — inserts an `admin_audit_log` row; every admin route calls it.
5. **UI shell** — `careervine/src/app/admin/layout.tsx` (server component): read the session server-side, redirect to `/` if not admin. `careervine/src/app/admin/page.tsx` = users list (Phase 2 fills it). Add a `useIsAdmin()` hook (reads `user.app_metadata.role` off `useAuth()`), and in `navigation.tsx` append `...(isAdmin ? [{ href:'/admin', label:'Admin', icon: ShieldCheck }] : [])`.

**Tests:** `requireAdmin` 403s a normal user and passes an admin (unit over the gate); `writeAudit` inserts a row.

## 7. Phase 1 — CAR-25 (AI policy + bundle access)

### 7a. AI fallback policy
Make the resolver policy-aware — one chokepoint, no call-site changes.

- In `careervine/src/lib/openai.ts`, `getOpenAIForUser(userId)` currently returns the **app client on every miss** (missing/invalid/expired user key). Change it to also read `users.ai_fallback_policy` (service client) and, when the user key is ineligible:
  - `policy === 'shared'` → return `{ client: appClient, source: 'app' }` (today's behavior).
  - `policy === 'cutoff'` → **throw `ApiError`** with a typed code (`AI_NO_KEY` / `AI_KEY_INVALID` / `AI_QUOTA_EXCEEDED`) and status 402/409.
- `runWithOpenAIFallback` similarly must respect `cutoff` on the mid-call 401/quota downgrade path (don't silently retry on the app client when policy is `cutoff`).
- Endpoints already throw `ApiError` → JSON; the typed code flows out. Polishing each feature's UI for these codes is **CAR-26 (out of scope)** — here we just guarantee a clean typed error, not a raw 500.
- Cache: the resolver caches per user (60s TTL) — include policy in the cache value, or invalidate on admin change (accept ≤60s lag; note it).

### 7b. Bundle visibility
- New route `careervine/src/app/api/bundles/list/route.ts` (`withApiHandler`) returning bundles the caller may see. Effective-visibility rule (bundles hidden until granted): a bundle is visible iff there is an override `allowed = true` for this user, **or** `default_visible = true` and no override `allowed = false`. With the chosen default (`default_visible = false`), that reduces to "visible only where the admin has granted an `allowed = true` override." Compute with the service client (overrides are service-role-only) but scope output to `ctx.user.id`.
- Refactor `data-subscriptions-section.tsx` `load()` to call this route instead of querying `data_bundles` directly, so hidden bundles never reach the browser.
- **Defense in depth:** `bundles/subscribe/route.ts` must re-check visibility server-side and 403 if the user isn't allowed (don't trust the list).

### 7c. Admin controls (user detail — see §6 shell)
- `PATCH /api/admin/users/[id]/ai-policy` → `{ ai_fallback_policy }`, service update + audit.
- `PUT /api/admin/users/[id]/bundle-access` → `{ bundleId, allowed }`, upsert `bundle_access_overrides` + audit.
- Admin user-detail UI: policy toggle (`cutoff`/`shared`) showing live key state (`user_api_keys.status`); a per-bundle allow/deny toggle list.

**Tests:** resolver matrix (§8) table-driven; user with `allowed=false` override doesn't get the bundle from `/api/bundles/list`; `cutoff` + no key → typed error, not app-client use; subscribe re-check 403s a hidden bundle.

### 8. AI resolver decision matrix (test spec)

| user key state | `shared` | `cutoff` |
|---|---|---|
| valid, quota ok | own key | own key |
| missing | shared key | `AI_NO_KEY` (402) |
| invalid | shared key | `AI_KEY_INVALID` (402) |
| quota_exceeded | shared key | `AI_QUOTA_EXCEEDED` (402) |

## 9. Phase 2 — CAR-23 (manage accounts)

**Admin API** (all `withApiHandler({ requireAdmin: true })`, service client, audited):
- `GET /api/admin/users` — list/search users: join `users` + `auth.users` (last_sign_in) + `user_api_keys.status`; query params for search/sort/pagination.
- `GET /api/admin/users/[id]` — full detail (profile, status, policy, key state, bundle access).
- `PATCH /api/admin/users/[id]` — edit `first_name/last_name/phone/email` (email change via `auth.admin.updateUserById`).
- `POST /api/admin/users/[id]/password` — `{ mode: 'link' | 'set', password? }`: `link` → `auth.admin.generateLink({ type:'recovery' })`; `set` → `auth.admin.updateUserById(id, { password })`.
- `POST /api/admin/users/[id]/status` — `{ status }`: suspend/reactivate.

**Suspend enforcement (decision §10.4 — default: block login):**
- On suspend, revoke sessions: `auth.admin.signOut(userId)` (global) so existing tokens die.
- In `auth-provider.tsx` `signIn`, after a successful `signInWithPassword`, fetch `users.status`; if `suspended`, `signOut()` and return a friendly error. Also short-circuit in `onAuthStateChange` so a lingering session can't rehydrate.
- Backstop: `withApiHandler` optionally rejects requests from suspended users (cheap `status` check) so API access dies even if the client is bypassed.

**UI:** `/admin` users table (search, status badge, AI policy, key state) → user-detail page with Profile / Security (reset-link, set-password, suspend) / AI / Bundles / Contacts panels. Reuse M3 primitives in `components/ui/`. Inline toggles with optimistic feedback (rule 5).

**Tests:** admin can edit another user's profile/password/status; suspended user is blocked at sign-in and API; every action writes `admin_audit_log`; non-admin 403 on each route.

## 10. Phase 3 — CAR-21 (contact injection)

- `POST /api/admin/users/[id]/contacts` — inject: `{ mode: 'manual', contact }` or `{ mode: 'bundle', bundleId }`. Reuse the existing contact-creation path but with the **target** `user_id` (service client), not `auth.uid()`. Bundle mode reuses the `bundles/apply` merge logic against the target account.
- `DELETE /api/admin/users/[id]/contacts/[contactId]` — remove.
- Both audited (`action: 'inject_contacts' | 'remove_contact'`, detail = ids/counts).
- **UI:** Contacts panel in user detail — add-contact form + "inject bundle" picker + a removable list.

**Tests:** admin add/remove reflects in the target account; bulk bundle inject creates the expected contacts; audited; non-admin 403.

## 11. Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | New bundle visibility | ✅ **Hidden until granted** (`default_visible = false`); admin grants per account via an `allowed = true` override. |
| 2 | Shared-key spend cap | **Deferred** — needs usage metering (CAR-20, out of scope). v1 is on/off `shared` vs `cutoff`. |
| 3 | Multi-admin | **Single admin** via `app_metadata` + `grant-admin.mjs` script. A "make admin" button is a trivial add later (one `app_metadata` write). |
| 4 | Suspend semantics | ✅ **Block login** (revoke sessions + sign-in gate + API backstop). |

All four settled — plan is ready to build.

## 12. Build order & Linear

1. Phase 0 foundation → **CAR-25** (start here)
2. Phase 1 AI policy + bundle access → **CAR-25**
3. Phase 2 account management → **CAR-23**
4. Phase 3 contact injection → **CAR-21**

Commit per phase; run `npm run test` (Vitest, from `careervine/`) before each commit (rules 3/4). Migrations are created here and applied via `supabase db push` (dry-run first) per rule 15.

## 13. Risks

- **RLS self-escalation** — the `users` self-update policy rewrite (§5) is the security crux; the regression test is mandatory, not optional.
- **`cutoff` regressions** — flipping the resolver from always-fallback to policy-gated touches all AI features; the matrix test guards it, but this is where a mistake silently breaks AI for real users.
- **Bundle visibility bypass** — the browser must never receive hidden bundles *and* subscribe must re-check; both, or neither is safe.
- **Suspend gaps** — client-side sign-in gate alone is bypassable; the session revoke + API backstop are what actually enforce it.
