# 32 — Admin Dashboard & User Management

**Linear:** Project "Admin Dashboard & User Management" · anchor issue [CAR-25](https://linear.app/career-vine/issue/CAR-25)
**Status:** Scoping
**Scope:** CAR-25 (core + foundation), CAR-23 (manage accounts), CAR-21 (contact injection)
**Depends on:** CAR-16 (BYO OpenAI keys — Done), CAR-5 (Data bundles — In Progress)

> Explicitly **out of scope** for this project: CAR-20 (usage logging), CAR-22 (analytics dashboards), CAR-26 (graceful AI-failure UX). They're separate concerns and stay standalone.

---

## 1. What this is

A single, admin-only surface (`/admin`) where the operator (Dawson) can see every user account and control what each account can do:

- **Data-bundle access** — per account, per bundle, control whether a user can even *see* a bundle as subscribable (CAR-25).
- **AI entitlements** — per account, decide what happens when a user's own OpenAI key is missing, invalid, or exhausted: fall back to the shared CareerVine key, or cut off AI (CAR-25).
- **Account lifecycle** — view/edit profile fields, reset passwords, suspend/reactivate accounts (CAR-23).
- **Direct data control** — inject or remove contacts from any user's account (CAR-21).

Everything the app does today is scoped to `auth.uid()` with per-user RLS. There is **no** notion of an admin, a role, an account status, or an entitlement anywhere in the schema or code today. This initiative introduces that layer from scratch, so the authorization design (Section 3) is the load-bearing decision — everything else hangs off it.

## 2. Current state (audit summary)

- **Stack:** Next.js 16 App Router, React 19, Supabase (Auth + Postgres + RLS), Vercel, Upstash. Client-side session via `AuthProvider`; no `middleware.ts`.
- **API gate:** `src/lib/api-handler.ts` → `withApiHandler({ handler })` calls `supabase.auth.getUser()`, 401s if absent, hands the handler an RLS-scoped client. This is the only auth gate and it only models "is this a logged-in user," not "is this an admin."
- **Service-role client:** `src/lib/supabase/service-client.ts` bypasses RLS. Already used by the bundle-publish pipeline. This is the tool admins will use to act across accounts.
- **`users` table:** `id, first_name, last_name, email, phone, created_at, updated_at`. No role, no status, no plan.
- **BYO keys:** `user_api_keys(user_id, provider, encrypted_key, key_last4, status ∈ {active,invalid,quota_exceeded})`, service-role-only. AI call sites already route per-user with a fallback to the shared key — but the fallback is **unconditional** today; CAR-25 makes it a per-account policy.
- **Bundles:** `data_bundles`, `bundle_subscriptions` (user_id-owned), bundle content readable only with an active subscription. No concept of "allowed to see this bundle."
- **Closest existing "admin":** `/api/admin/bundles/publish` — a machine route gated by a shared `BUNDLE_ADMIN_TOKEN` bearer secret. It authenticates a *script*, not a *human admin*, so it is not reusable as the dashboard's auth model.

## 3. Authorization design (the load-bearing decision)

**Recommendation: store the admin claim in Supabase `auth.users.app_metadata.role`, not on `public.users`.**

Rationale (this is a security boundary, so pick the correct option, not the easy one):

- `app_metadata` is writable **only** by the service role / Supabase admin API — a user cannot edit it. If we instead put `is_admin` on `public.users`, the existing `UPDATE ... USING (id = auth.uid())` RLS policy would let a user flip their own row to admin (Postgres RLS can't cheaply restrict *which columns* an update touches). That's a privilege-escalation hole. `app_metadata` closes it by construction.
- `app_metadata` is embedded in the JWT, so it's checkable both in API routes (`user.app_metadata.role`) and, if we ever want it, in RLS (`auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'`) with zero extra queries.
- Bootstrapping: a one-off script sets `role: 'admin'` on Dawson's `auth.users` row via the admin API. Documented, reversible.

**Enforcement:** extend `withApiHandler` with a `requireAdmin: true` option that 403s unless `user.app_metadata.role === 'admin'`. Admin routes live under `/api/admin/**` and use the **service-role client** for cross-user reads/writes (rather than sprinkling admin RLS policies across every table — fewer moving parts, one audited choke point). Every admin write goes through a helper that also appends an `admin_audit_log` row.

**UI gating:** an `/admin` route segment whose layout server-checks the admin claim and redirects non-admins; the nav entry renders only for admins. Defense-in-depth — the real gate is the API, but we don't render the surface to non-admins.

## 4. Data model additions

```
-- Account status (suspension). Read-only to the user, writable only via service role.
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended'));

-- Per-account AI fallback policy (CAR-25).
-- Governs behavior when the user's own key is missing / invalid / quota_exceeded.
ALTER TABLE users ADD COLUMN ai_fallback_policy text NOT NULL DEFAULT 'cutoff'
  CHECK (ai_fallback_policy IN ('cutoff','shared'));
-- default 'cutoff' protects the shared key's spend; admin opts specific accounts into 'shared'.

-- Per-(user,bundle) access override (CAR-25). Absence = bundle's own default visibility.
CREATE TABLE bundle_access_overrides (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL REFERENCES data_bundles(id) ON DELETE CASCADE,
  allowed   boolean NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bundle_id)
);
ALTER TABLE data_bundles ADD COLUMN default_visible boolean NOT NULL DEFAULT true;
-- Effective visibility = override.allowed if a row exists, else data_bundles.default_visible.

-- Admin action audit trail (who did what to whom).
CREATE TABLE admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  action text NOT NULL,              -- 'suspend','reset_password','grant_bundle','inject_contacts',...
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
```

All new tables: RLS on, no authenticated policy (service-role only), consistent with `user_api_keys`.

## 5. AI fallback resolution (CAR-25)

Today the ~11 AI call sites fall back to the shared key **unconditionally**. This project makes the fallback a per-account decision via one server-side resolver:

| User key state | policy = `shared` | policy = `cutoff` |
|---|---|---|
| valid, has quota | use own key | use own key |
| missing | use shared key | refuse (AI unavailable) |
| invalid | use shared key | refuse (AI unavailable) |
| quota_exceeded | use shared key | refuse (AI unavailable) |

- The resolver is the single place the fallback decision is made — refactor the call sites to route through it.
- When it refuses, endpoints return a clear, typed error rather than a raw 500 so the caller can show a sensible message. (Making *every* AI feature's UI render a polished unavailable-state is CAR-26 — tracked separately, not part of this project.)

> Note: metering how much of the shared key a given account has spent requires usage logging (CAR-20), which is out of scope here. So the v1 policy is a straight on/off (`shared` vs `cutoff`); a per-account spend **cap** is deferred until that logging exists — see open decision 2.

## 6. Admin surface (UX)

`/admin` with two sections in the nav:

1. **Users** — searchable/sortable table (name, email, status, AI policy, key state). Row → **User detail**:
   - Profile: edit first/last/phone/email (CAR-23).
   - Security: send reset link or set a password directly via Supabase admin API (CAR-23); suspend / reactivate.
   - AI: fallback policy toggle (`cutoff`/`shared`) + live key state (CAR-25).
   - Data bundles: a per-bundle allow/deny toggle list; the user's subscribe UI honors it (CAR-25).
   - Contacts: inject (from a bundle or manual) / remove contacts on the user's behalf (CAR-21).
2. **Audit log** — `admin_audit_log`, filterable by admin/target/action.

UX bar (rule 5): the users table and detail view must feel effortless — fast search, inline toggles with optimistic feedback, no dead-end error states. Internal tool, same clean/intuitive standard.

## 7. Phasing → Linear mapping

| Phase | Deliverable | Issue |
|---|---|---|
| 0 | Admin identity (`app_metadata.role`), `requireAdmin` gate, `/admin` shell + nav gating, `admin_audit_log` | (foundation, in **CAR-25**) |
| 1 | AI fallback policy field + resolver refactor; per-(user,bundle) access overrides + subscribe-UI filtering | **CAR-25** |
| 2 | Users list + detail; profile edit; password reset/set; suspend/reactivate (`users.status`) | **CAR-23** |
| 3 | Inject / remove contacts on behalf of a user | **CAR-21** |

CAR-25 carries the shared foundation (Phase 0), which is why it goes first — CAR-23 and CAR-21 are additional panels on the same gated surface and have no admin to authenticate without it. CAR-25 depends on CAR-16 (done) + CAR-5 (in progress).

## 8. Open decisions (need Dawson's call before build)

1. **Bundle-access default** — should a newly published bundle be visible to all users by default (admin hides per account), or hidden by default (admin grants per account)? Plan assumes `default_visible = true`. *(Gated/curated products often prefer default-hidden.)*
2. **Shared-key spend cap** — a per-account monthly $ cap needs shared-key usage metering (CAR-20), which is out of scope here. OK to ship v1 as a simple on/off `shared` policy and defer the cap?
3. **Multi-admin** — single-admin (just you) indefinitely, or should the dashboard let you promote other users to admin? Affects whether we build a "make admin" control or keep it a manual script.
4. **Suspend semantics** — does "suspended" mean can't-log-in at all, or logged-in-but-read-only? Plan assumes can't-log-in (session invalidation + login block).

## 9. Test coverage (rule 3/4)

- Auth gate: `requireAdmin` 403s non-admins; admin passes. RLS-escalation regression test (a normal user cannot set their own `status`/role).
- Resolver: table-driven test over the Section 5 matrix.
- Entitlement filtering: user with a deny override doesn't see the bundle; default path unaffected.
- Admin actions write `admin_audit_log` rows.
- Run `npm run test` (Vitest) from `careervine/` before any commit.
