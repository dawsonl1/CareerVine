# 32 — Admin Dashboard & User Management

**Linear:** Project "Admin Dashboard & User Management" · anchor [CAR-25](https://linear.app/career-vine/issue/CAR-25)
**Status:** Detailed plan — revised after adversarial audit (UX + technical + sequencing). Ready to build.
**Scope:** CAR-25 (foundation + AI policy + bundle access), CAR-23 (manage accounts), CAR-21 (contact injection)
**Depends on:** CAR-16 (BYO OpenAI keys — Done), CAR-5 (Data bundles — In Progress)

> **Out of scope** (separate standalone issues): CAR-20 usage logging, CAR-22 analytics, CAR-26 graceful AI-failure UX.
> **Audit note:** this revision folds in three parallel audits. The biggest corrections: AI-policy default flipped to `shared` (was a flag-day outage), bundle visibility moved into RLS (API filter alone is bypassable), a migration type bug fixed (`data_bundles.id` is `int`, not `uuid`), and the build order reworked so the highest-blast-radius change lands last.

---

## 1. Goal

Admin-only `/admin` surface where the operator (Dawson) controls individual user accounts: **bundle access** (per account, per bundle), **AI key policy** (shared fallback vs cutoff), **account lifecycle** (edit / password / suspend), and **contact control** (inject / remove). The app has no admin concept today — everything is `auth.uid()`-scoped RLS — so this builds that layer from scratch.

## 2. Authorization design (load-bearing)

Admin claim lives in Supabase **`auth.users.app_metadata.role`** — writable only by the service role / admin API (users cannot self-promote; they can only write `user_metadata`), and JWT-carried so it's checkable with zero queries. An `is_admin` column on `public.users` is rejected: the existing self-update policy would let a user set it.

**Enforcement:** a `requireAdmin: true` option on `withApiHandler`; admin routes under `api/admin/**`; past the gate, use the **service-role client** for cross-account work; every mutation writes an `admin_audit_log` row. This differs from the existing `BUNDLE_ADMIN_TOKEN` machine route (authenticates a *script* by shared secret, not a *human* by session).

**Operational note:** `app_metadata.role` only enters the JWT on the next token refresh. After `grant-admin.mjs` runs, Dawson must sign out/in once before `/admin` is reachable. The layout gate and API gate read the same claim, so they stay consistent.

## 3. Integration points (verified)

| Concern | File / symbol |
|---|---|
| API gate | `careervine/src/lib/api-handler.ts` → `withApiHandler`, `RouteConfig`, `HandlerContext`, `ApiError` |
| Service / server client | `careervine/src/lib/supabase/service-client.ts` `createSupabaseServiceClient()`; `server-client.ts` `createSupabaseServerClient()` |
| AI resolver | `careervine/src/lib/openai.ts` → `getOpenAIForUser`, `runWithOpenAIFallback`, `createOpenAIRunner`, `getAppOpenAIClient`, `ResolvedOpenAI`, `isUserKeyEligible`, `markKeyStatus`, `evictOpenAIKeyCache` |
| Bundle list (browser) | inline query in `careervine/src/components/settings/data-subscriptions-section.tsx` `load()` |
| Bundle routes | `careervine/src/app/api/bundles/{subscribe,unsubscribe,apply}/route.ts` |
| Bundle crons | `careervine/src/app/api/cron/{send-scheduled-emails,send-follow-ups,sync-bundles}/route.ts` (service client, outside `withApiHandler`) |
| Nav | `careervine/src/components/navigation.tsx` `navItems`; avatar link → `/settings` (line ~115) |
| Auth/session | `careervine/src/components/auth-provider.tsx` `signIn`, `onAuthStateChange` |
| Profile update | `account-section.tsx`; `queries.ts` `updateUserProfile`, `getUserProfile`; password via `supabase.auth.updateUser({ password })` |
| UI primitives to reuse | `components/ui/` → `modal.tsx`, `toast.tsx` (`useToast`, undo variant), `card`, `button`, `toggle`; settings sidebar-tab shell in `app/settings/page.tsx`; status-pill in `settings/ai-key-section.tsx` (~161-188) |
| Migrations | `supabase/migrations/`, `YYYYMMDDHHMMSS_snake.sql`; **`data_bundles.id` is `int`**, `users.id` is `uuid` |
| Existing users RLS | `20260214065459_add_rls_policies.sql` → real policy names `users_update_own` (USING only, **no WITH CHECK**), `users_insert_own` |
| Bundle RLS | `20260709000000_data_bundles.sql` → `data_bundles_select_published`, `bundle_prospects_select_subscribed`, `bundle_companies_select_subscribed`, `bundle_subscriptions_insert_own` |

---

## 4. Data model & RLS

### 4a. Migration `<ts>_admin_dashboard_foundation.sql`

```sql
-- ── Account status (CAR-23) ────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended'));

-- ── Per-account AI fallback policy (CAR-25) ────────────────────────────────
-- DEFAULT 'shared' PRESERVES today's unconditional-fallback behavior for every
-- existing user. 'cutoff' is an explicit per-account admin choice. (Audit C2:
-- defaulting to 'cutoff' would be a flag-day AI outage for all keyless users.)
ALTER TABLE users ADD COLUMN ai_fallback_policy text NOT NULL DEFAULT 'shared'
  CHECK (ai_fallback_policy IN ('cutoff','shared'));

-- ── Column-privilege guard (primary defense vs self-escalation) ────────────
-- RLS alone can't cheaply restrict WHICH columns an update touches; column
-- privileges can. authenticated may update only profile columns.
REVOKE UPDATE ON users FROM authenticated;
GRANT  UPDATE (first_name, last_name, email, phone, updated_at) ON users TO authenticated;
-- Secondary belt-and-suspenders: pin privileged columns in the RLS WITH CHECK too.
DROP POLICY IF EXISTS users_update_own ON users;
CREATE POLICY users_update_own ON users FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND status             = (SELECT u.status             FROM users u WHERE u.id = auth.uid())
    AND ai_fallback_policy = (SELECT u.ai_fallback_policy FROM users u WHERE u.id = auth.uid())
  );

-- ── Bundle visibility (CAR-25). data_bundles.id is INT → bundle_id is bigint ─
ALTER TABLE data_bundles ADD COLUMN default_visible boolean NOT NULL DEFAULT false;
-- Backfill: keep already-published bundles visible so nobody loses access on deploy
-- (audit C3). New bundles default hidden per decision §10.1.
UPDATE data_bundles SET default_visible = true WHERE status = 'published';

CREATE TABLE bundle_access_overrides (
  user_id    uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bundle_id  bigint NOT NULL REFERENCES data_bundles(id) ON DELETE CASCADE,
  allowed    boolean NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bundle_id)
);
ALTER TABLE bundle_access_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY bundle_access_overrides_service_role_all ON bundle_access_overrides
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON bundle_access_overrides FROM anon, authenticated;

-- One shared visibility predicate, used by every bundle policy below.
-- SECURITY DEFINER so it can read the service-role-only overrides table.
CREATE OR REPLACE FUNCTION bundle_visible_to(p_bundle_id bigint, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM bundle_access_overrides o
                 WHERE o.bundle_id = p_bundle_id AND o.user_id = p_user AND o.allowed = false) THEN false
    WHEN EXISTS (SELECT 1 FROM bundle_access_overrides o
                 WHERE o.bundle_id = p_bundle_id AND o.user_id = p_user AND o.allowed = true)  THEN true
    ELSE COALESCE((SELECT default_visible FROM data_bundles b WHERE b.id = p_bundle_id), false)
  END;
$$;

-- ── Rewrite bundle RLS so visibility is enforced at the DATA layer ─────────
-- (audit C1: the API list-filter is bypassable via the browser client.)
DROP POLICY IF EXISTS data_bundles_select_published ON data_bundles;
CREATE POLICY data_bundles_select_published ON data_bundles FOR SELECT
  USING (status = 'published' AND bundle_visible_to(id, auth.uid()));

DROP POLICY IF EXISTS bundle_prospects_select_subscribed ON bundle_prospects;
CREATE POLICY bundle_prospects_select_subscribed ON bundle_prospects FOR SELECT
  USING (bundle_visible_to(bundle_id, auth.uid())
         AND EXISTS (SELECT 1 FROM bundle_subscriptions s
                     WHERE s.bundle_id = bundle_prospects.bundle_id AND s.user_id = auth.uid()));
-- same rewrite for bundle_companies_select_subscribed.

-- Can't self-subscribe to a bundle you're not allowed to see.
DROP POLICY IF EXISTS bundle_subscriptions_insert_own ON bundle_subscriptions;
CREATE POLICY bundle_subscriptions_insert_own ON bundle_subscriptions FOR INSERT
  WITH CHECK (user_id = auth.uid() AND bundle_visible_to(bundle_id, auth.uid()));

-- ── Admin audit log ────────────────────────────────────────────────────────
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id       uuid NOT NULL REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  action  text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL DEFAULT 'ok',        -- 'ok' | 'error'; lets us record intent+result
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_audit_log_service_role_all ON admin_audit_log
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON admin_audit_log FROM anon, authenticated;
```

After apply: regenerate `database.types.ts` **from the local migrated schema**, not prod (rule 12 — prod carries untracked drift); eyeball the diff to only the new columns/tables.

### 4b. Verify the existing policy names before writing
The DROP/CREATE names above must match `20260214065459_add_rls_policies.sql` and `20260709000000_data_bundles.sql` exactly. Confirm at build time; the audit verified `users_update_own` and the four bundle policy names, but re-check.

---

## 5. AI fallback resolver (CAR-25)

Make `getOpenAIForUser` policy-aware at the single chokepoint. Extend the return type so the **mid-call** downgrade path can honor policy without a second read (audit C2):

```ts
type ResolvedOpenAI = { client: OpenAI; source: 'user' | 'app'; policy: 'shared' | 'cutoff' };
```

- `getOpenAIForUser(userId)`: read `ai_fallback_policy` alongside the existing `user_api_keys` read (**one joined read / RPC**, not a second round-trip — audit N3). When the user key is ineligible (missing/invalid/quota):
  - `policy === 'shared'` → `{ client: appClient, source: 'app', policy }` (today's behavior).
  - `policy === 'cutoff'` → **throw `ApiError`** with typed code (`AI_NO_KEY` / `AI_KEY_INVALID` / `AI_QUOTA_EXCEEDED`, status 402).
- `runWithOpenAIFallback`: the catch that today retries on the app client for a mid-call 401/quota must check `resolved.policy`; under `cutoff`, `markKeyStatus` + `evictOpenAIKeyCache` then **throw** instead of retrying on the shared key (closes the "cutoff user still spends shared key mid-call" hole).
- **Cache:** fold `ai_fallback_policy` into the cached entry. Do **not** promise cross-request cache invalidation on admin change — the cache is per-lambda in-memory on Vercel (audit N2); accept the ≤60s TTL lag and document that a `cutoff` flip stops shared spend within ≤60s. (Staleness is minor: the miss path — where policy matters — isn't cached.)
- **Default `shared`** means no call-site behavior changes on deploy; `cutoff` only affects accounts an admin explicitly flips.

**Decision matrix (test spec):**

| user key state | `shared` | `cutoff` |
|---|---|---|
| valid, quota ok | own key | own key |
| missing | shared | `AI_NO_KEY` (402) |
| invalid | shared | `AI_KEY_INVALID` (402) |
| quota_exceeded | shared | `AI_QUOTA_EXCEEDED` (402) |
| mid-call 401/quota on own key | retry shared | throw typed 402 |

Polishing every feature's UI for these codes is CAR-26 (out of scope); here we only guarantee a clean typed error, not a raw 500.

## 6. Bundle visibility (CAR-25)

RLS (§4a) is now the real boundary. On top of it:
- `careervine/src/app/api/bundles/list/route.ts` (`withApiHandler`) returns the caller's visible bundles. Because RLS already filters, the **browser client's existing query also returns only visible bundles** — but route it through this API anyway for a single source of truth and so we can enrich with subscription state.
- `data-subscriptions-section.tsx` `load()` calls this route.
- `subscribe/route.ts` keeps a visibility check as defense-in-depth, but it must read `bundle_access_overrides` via the **service client** (that table is `REVOKE ALL … authenticated` — a user-client read returns nothing). RLS `WITH CHECK` is what actually blocks a direct self-insert.
- Admin controls: `PUT /api/admin/users/[id]/bundle-access` `{ bundleId, allowed }` upserts an override + audit.

## 7. Account management (CAR-23)

Admin API, all `withApiHandler({ requireAdmin: true })`, service client, audited:
- `GET /api/admin/users` — list/search (email OR name, debounced), join `auth.users.last_sign_in_at` + `user_api_keys.status`; sort + paginate.
- `GET /api/admin/users/[id]` — full detail.
- `PATCH /api/admin/users/[id]` — profile. **Email is dual-source** (`auth.users` + UNIQUE `public.users.email`): update auth via `auth.admin.updateUserById` first, then `public.users`; if the second fails, surface the inconsistency and don't report success (audit S3). Wrap both + audit in one Postgres RPC where practical for atomicity.
- `POST /api/admin/users/[id]/password`:
  - `mode: 'link'` → `auth.admin.generateLink({ type:'recovery' })` **returns a URL; it does not email anyone.** Return it to the admin UI, shown once in a modal with copy-to-clipboard + "single-use / expires" note (audit C4). (No confirmed user-facing SendGrid path exists to auto-send it.)
  - `mode: 'set'` → `auth.admin.updateUserById(id, { password })`, then `auth.admin.signOut(id)` so a compromised session can't persist.
- `POST /api/admin/users/[id]/status` — suspend / reactivate.
- `DELETE /api/admin/users/[id]` — **account deletion** (audit N1): `auth.admin.deleteUser(id)` (cascades via FK), audited, behind a typed-confirmation modal. Include it; offboarding/erasure needs it.

### 7a. Suspend = freeze the account, not just block login (audit C3)
Login-block alone is leaky — the user's server-side work keeps running. Enforce at every layer:
1. On suspend: `auth.admin.signOut(id)` (revoke refresh tokens).
2. Client `signIn`: after a successful `signInWithPassword`, read `users.status`; if `suspended`, `signOut()` + return a distinct "account suspended" error (dedicated message + support-contact line, not a generic failure). Short-circuit `onAuthStateChange` too.
3. **Server automation:** add `WHERE users.status = 'active'` guards to `send-scheduled-emails`, `send-follow-ups`, and `sync-bundles` so a suspended user's queued sends/syncs stop. Decide + document: held vs dropped (recommend held — reactivation resumes).
4. **API backstop:** rather than a `users` SELECT on every request (latency on the hottest path), **mirror `status` into `app_metadata`** like `role` so `withApiHandler` checks the JWT with zero queries. Cost: suspend becomes an `auth.admin.updateUserById` write and takes effect on next token refresh — acceptable because (1) already revoked the session. Verify empirically whether `getUser()` already rejects a globally-revoked session (GoTrue behavior) before deciding how load-bearing the backstop is (audit S2).

## 8. Contact injection (CAR-21)

- `POST /api/admin/users/[id]/contacts` — `{ mode: 'manual', contact }` or `{ mode: 'bundle', bundleId }`; reuse the contact-creation / `bundles/apply` merge path with the **target** `user_id`.
- `DELETE /api/admin/users/[id]/contacts/[contactId]`.
- Both audited (`inject_contacts` with count / `remove_contact`).

## 9. Audit logging (atomicity — audit S4)

`writeAudit` must not be silently best-effort. Preferred: perform the mutation and the audit insert in **one Postgres RPC/transaction** so they commit together. Where a route can't (e.g. a Supabase admin-API call that isn't in-DB), write the audit row with `outcome='error'` on failure and **log loudly** — never swallow. Record intent before the mutation where feasible.

---

## 10. UX specification (rule 5 — the audit's biggest gap)

The admin surface reuses the app's existing idioms; it must not invent foreign UI. **The app has no `<table>` anywhere** — every list is a responsive card/row.

### 10a. Information architecture & navigation
- **Not** a top-nav pill (clutter for a single admin; pushes the 1200px overflow sooner). Put "Admin" in the **settings sidebar / avatar affordance** (the avatar already links to `/settings`). The API gate is the boundary; nav placement is pure UX (audit S8).
- `/admin` uses the **settings sidebar-tab shell** (`app/settings/page.tsx` pattern): left rail = **Users**; a selected user opens a detail view with tabs **Profile / Security / AI / Bundles / Contacts / Activity**.

### 10b. Users list
- Card/row list (not a table), responsive `flex-col sm:flex-row`: primary line = name + email; secondary = chips for `status`, key state, AI policy; right = last sign-in.
- Single **search field** (email OR name), debounced, with a visible result count and a **no-match empty state**. Loading spinner + fetch-error state (reuse `account-section` patterns).

### 10c. Destructive-action policy (audit C1 — the safety gap)
Honor plan 08's deliberate confirm/undo split. Never optimistic for irreversible cross-account writes:
| Action | Pattern |
|---|---|
| Suspend / set-password / delete account | Explicit confirm **Modal** echoing the target's email (delete = type-to-confirm). Undo-by-timer is wrong for credential/session changes. |
| Remove a contact | Plan-08 **undo toast** (deferred delete + countdown). |
| Inject a bundle (N contacts) | Confirm **Modal** stating the count, mirroring the unsubscribe modal's "X added" clarity. |
| Reversible toggles (bundle grant) | Optimistic + `useToast` confirm is fine. |
All mutations show a **success toast** via `useToast` ("Suspended jane@x.com — sessions revoked"); confirmed (not optimistic) writes for the irreversible ones.

### 10d. Panel specifics
- **AI tab:** a labeled **segmented control / radio pair** — "Fall back to shared key" vs "Cut AI off" — **not** a bare toggle (`cutoff`/`shared` has no natural on/off). One line of copy per option (cutoff = the user gets a hard AI error). Show the **exact `ai-key-section` status pill** so the admin sees what the user sees; label it "last observed" and compute `isUserKeyEligible` for display since `quota_exceeded` auto-recovers (audit N2). Note the ≤60s policy lag inline.
- **Bundles tab:** per-bundle allow/deny, but show **current state next to each** (not granted / granted / granted + subscribed) and one line distinguishing "**Grant access** (they can then subscribe)" from the Contacts tab's "**Inject now** (you add the contacts for them)" — two bundle-shaped actions with opposite effects (audit S7). Add search/filter + a "granted only" view if the catalog exceeds ~10.
- **Activity tab:** surface `admin_audit_log` for this `target_user_id` as a readable timeline (action + friendly detail + timestamp), not raw JSON (audit S5). The audit trail is otherwise write-only and invisible.
- **Empty/loading/error** states specified for every list, detail, and tab (audit C3).

### 10e. Suspended user's own experience
A distinct "Your account is suspended" screen/message with a support-contact line — not a generic sign-in failure (audit N13).

---

## 11. Testing strategy (honest about the harness — audit C4)

The repo's suite (`careervine/src/__tests__/`, `vitest.config.ts`, `environment: node`) is **pure unit tests with a mocked service client** — it cannot exercise RLS `WITH CHECK`, column privileges, or the `bundle_visible_to` function. So:

- **Unit (Vitest, blocking per rules 3/4):** `requireAdmin` 403/pass in `api-handler.test.ts`; the §5 resolver matrix incl. the mid-call row in `openai-routing.test.ts`; `bundles/list` shape; suspend guard logic; `writeAudit` behavior.
- **DB/RLS (new, Phase 0 infra):** the self-escalation guard, column privileges, and `bundle_visible_to` policies **must** be verified against a real Postgres. Add a `supabase db reset` + SQL-assertion (or pgTAP) job — a small, documented harness the plan explicitly budgets for. Until it exists, verify manually against local `supabase start` with the exact `psql` reproductions checked into the plan/PR. **Do not** claim these are covered by `npm run test`.
- Every admin action asserts an `admin_audit_log` row; non-admin 403 on each route.

---

## 12. Build order (reworked — highest-blast-radius change lands last)

The two changes that can break prod for *every* user (the AI-policy resolver flip, the bundle-visibility filter) move out of "foundation" and land late, isolated, revertible. CAR-23 read-only fills the empty shell first so Phase 0 doesn't ship a dead-end nav link.

| Slice | Content | Issue |
|---|---|---|
| **0 — Foundation (behavior-neutral)** | Migration §4a (with `shared` default, `bigint` FK, published backfill, column-priv guard, visibility RLS + function) applied & verified; `grant-admin.mjs`; `requireAdmin` gate; `lib/admin.ts` (`isAdmin`, transactional `writeAudit`); `/admin` shell behind settings/avatar; RLS test harness. | CAR-25 |
| **1 — CAR-23 read-only** | Users list + detail (fills the shell); search/empty/loading/error states. | CAR-23 |
| **2 — CAR-23 edit** | Profile edit (dual-source email), password link/set modals. | CAR-23 |
| **3 — CAR-23 suspend + enforcement** | status writes, session revoke, sign-in gate, cron guards, JWT-mirrored backstop — isolated (shared auth path). | CAR-23 |
| **4 — Bundle visibility** | `bundles/list` route + UI reroute + admin grant controls (RLS already enforces). Additive. | CAR-25 |
| **5 — AI-policy flip** | Policy-aware resolver §5 — landed **last**, gated by the matrix test, since it touches every AI feature. | CAR-25 |
| **6 — Contact injection** | Inject/remove. | CAR-21 |

**Deploy ordering (rules 15/16 — `main` auto-deploys Vercel):** the migration commit merges and `supabase db push` is run + verified in prod **before** any commit whose code reads the new columns. One PR per slice (small reviews) off `dawson/admin-dashboard-scope-c682cf`. `npm run test` green before each commit.

## 13. Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | New bundle visibility | **Hidden until granted** (`default_visible = false` for new; existing published backfilled to `true` so no regression). |
| 2 | Shared-key spend cap | **Deferred** (needs CAR-20 metering). v1 is on/off. |
| 3 | Multi-admin | **Single admin** via `app_metadata` + `grant-admin.mjs`. |
| 4 | Suspend semantics | **Freeze the account** — block login *and* stop server-side automation, not just login. |
| 5 | AI-policy default | **`shared`** globally (preserves current behavior); `cutoff` is opt-in per account. *(New from audit.)* |
| 6 | Account deletion | **In scope** for CAR-23 (audit N1). |

## 14. Top risks

- **Bundle-visibility RLS rewrite** — the security crux; must be verified against real Postgres (§11), not mocked. A wrong predicate either leaks hidden bundles or hides everything.
- **AI-policy flip** — touches every AI feature; `shared` default + landing last + matrix test are what keep it safe.
- **Migration-before-deploy ordering** — a code commit reading a not-yet-applied column breaks prod harder than the bug it adds.
- **Suspend leakage** — enforcement must cover crons + API, not just the login form.
- **Self-escalation** — column privileges are the primary guard; the RLS WITH CHECK is secondary.
