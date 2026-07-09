# 32 — Admin Dashboard & User Management

**Linear:** Project "Admin Dashboard & User Management" · anchor issue [CAR-25](https://linear.app/career-vine/issue/CAR-25)
**Status:** Scoping
**Depends on:** CAR-16 (BYO OpenAI keys — Done), CAR-5 (Data bundles — In Progress)

---

## 1. What this is

A single, admin-only surface (`/admin`) where the operator (Dawson) can see every user account and control what each account can do:

- **Account lifecycle** — view/edit profile fields, reset passwords, suspend/reactivate accounts (CAR-23).
- **AI entitlements** — per account, decide what happens when a user's own OpenAI key is missing, invalid, or exhausted: fall back to the shared CareerVine key, or cut off AI entirely (CAR-25, CAR-26).
- **Data-bundle access** — per account, per bundle, control whether a user can even *see* a bundle as subscribable (CAR-25).
- **Direct data control** — inject or remove contacts from any user's account (CAR-21).
- **Observability** — detailed per-user activity/usage logging (CAR-20) and management dashboards that chart those stats over time (CAR-22).

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
- Bootstrapping: a one-off migration/script sets `role: 'admin'` on Dawson's `auth.users` row via the admin API. Documented, reversible.

**Enforcement:** extend `withApiHandler` with a `requireAdmin: true` option that 403s unless `user.app_metadata.role === 'admin'`. Admin routes live under `/api/admin/**` and use the **service-role client** for cross-user reads/writes (rather than sprinkling admin RLS policies across every table — fewer moving parts, one audited choke point). Every admin write goes through a helper that also appends an `admin_audit_log` row.

**UI gating:** an `/admin` route segment whose layout server-checks the admin claim and redirects non-admins; the nav entry renders only for admins. Defense-in-depth — the real gate is the API, but we don't render the surface to non-admins.

## 4. Data model additions

```
-- Account status (suspension). Lives on public.users; read-only to the user, writable only via service role.
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','suspended'));

-- Per-account AI fallback policy (CAR-25 / CAR-26).
-- Governs behavior when the user's own key is missing / invalid / quota_exceeded.
ALTER TABLE users ADD COLUMN ai_fallback_policy text NOT NULL DEFAULT 'cutoff'
  CHECK (ai_fallback_policy IN ('cutoff','shared'));
-- default 'cutoff' protects the shared key's spend; admin opts specific accounts into 'shared'.

-- Optional shared-key monthly budget (cents) when policy = 'shared'. NULL = unlimited.
ALTER TABLE users ADD COLUMN shared_ai_monthly_cap_cents integer;

-- Per-(user,bundle) access override (CAR-25). Absence = bundle's own default visibility.
CREATE TABLE bundle_access_overrides (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL REFERENCES data_bundles(id) ON DELETE CASCADE,
  allowed   boolean NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bundle_id)
);
-- data_bundles gets a default: ALTER TABLE data_bundles ADD COLUMN default_visible boolean NOT NULL DEFAULT true;
-- Effective visibility = override.allowed if a row exists, else data_bundles.default_visible.

-- Usage / activity events (CAR-20) — the raw log everything else aggregates from.
CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL,          -- 'ai_call','login','contact_created','email_sent',...
  key_source text,                   -- 'own' | 'shared' | null  (for ai_call)
  model text,                        -- for ai_call
  prompt_tokens integer, completion_tokens integer, cost_cents integer,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Indexed on (user_id, created_at) and (event_type, created_at). Service-role write only.

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

## 5. AI resolution logic (unifies CAR-25 + CAR-26)

One server-side resolver decides, per request, which key (if any) to use and returns a **typed outcome** the UI can render consistently:

| User key state | policy = `shared` | policy = `cutoff` |
|---|---|---|
| valid, has quota | use own key | use own key |
| missing | use shared (respecting cap) | `AI_NO_KEY` |
| invalid | use shared (respecting cap) | `AI_KEY_INVALID` |
| quota_exceeded | use shared (respecting cap) | `AI_QUOTA_EXCEEDED` |
| shared cap hit (policy=shared) | `AI_SHARED_CAP_REACHED` | n/a |

- The resolver is the single place the fallback decision is made (today it's unconditional in `src/lib/` AI call sites — refactor to route through the resolver).
- Every AI endpoint returns these typed error codes instead of a generic 500. **CAR-26** is the UI contract: each AI feature renders a consistent "AI unavailable — <reason>" state with the right CTA (add a key / your key is invalid / usage exhausted), never a silent failure or a raw error.
- Every successful AI call writes a `usage_events` row with `key_source`, tokens, and estimated `cost_cents` — this is what powers shared-key cap enforcement (CAR-25) and the analytics dashboards (CAR-22), and it's how we detect "shared spend" without seeing the user's own OpenAI balance.

## 6. Admin surface (UX)

`/admin` with three sections in the nav:

1. **Users** — searchable/sortable table (name, email, status, AI policy, key state, last active). Row → **User detail**:
   - Profile: edit first/last/phone/email (CAR-23).
   - Security: send reset link or set a password directly via Supabase admin API (CAR-23); suspend / reactivate.
   - AI: fallback policy toggle (`cutoff`/`shared`) + optional monthly cap (CAR-25); live key state.
   - Data bundles: a per-bundle allow/deny toggle list; the user's subscribe UI honors it (CAR-25).
   - Contacts: inject (from a bundle or manual) / remove contacts on the user's behalf (CAR-21).
   - Activity: recent `usage_events` for this user (CAR-20).
2. **Analytics** — charts over `usage_events`: AI calls & cost over time (own vs shared), active users, feature usage, bundle adoption (CAR-22). Follow the `dataviz` skill for any charting.
3. **Audit log** — `admin_audit_log`, filterable by admin/target/action.

UX bar (rule 5): the users table and detail view must feel effortless — fast search, inline toggles with optimistic feedback, no dead-end error states. This is an internal tool but held to the same clean/intuitive standard.

## 7. Phasing → Linear mapping

| Phase | Deliverable | Issue |
|---|---|---|
| 0 | Admin identity (`app_metadata.role`), `requireAdmin` gate, `/admin` shell + nav gating, `admin_audit_log` | (foundation of CAR-25) |
| 1 | Users list + detail; profile edit; password reset/set; suspend/reactivate (`users.status`) | **CAR-23** |
| 2 | AI fallback policy field + resolver refactor; per-(user,bundle) access overrides + subscribe-UI filtering | **CAR-25** |
| 3 | Typed AI error codes end-to-end + consistent "AI unavailable" UI in every AI feature | **CAR-26** (blocked by CAR-25) |
| 4 | `usage_events` metering (AI tokens/cost, logins, feature events); shared-key per-user budget enforcement | **CAR-20** |
| 5 | Analytics dashboards over `usage_events` | **CAR-22** (blocked by CAR-20) |
| 6 | Admin contact injection / removal on behalf of a user | **CAR-21** |

Dependency edges: CAR-25 depends on CAR-16 (done) + CAR-5 (in progress); CAR-26 blocked by CAR-25; CAR-22 blocked by CAR-20.

## 8. Open decisions (need Dawson's call before build)

1. **Bundle-access default** — should a newly published bundle be visible to all users by default (admin hides per account), or hidden by default (admin grants per account)? Plan assumes `default_visible = true`. *(Gated/curated products often prefer default-hidden.)*
2. **Shared-key spend control** — is a per-account monthly **cap** (cents) worth building in Phase 2/4, or is a simple on/off `shared` policy enough for now?
3. **Multi-admin** — is this single-admin (just you) indefinitely, or should the dashboard let you promote other users to admin? Affects whether we build a "make admin" control or keep it a manual script.
4. **Suspend semantics** — does "suspended" mean can't log in at all, or logged-in-but-read-only? Plan assumes can't-log-in (session invalidation + login block).

## 9. Test coverage (rule 3/4)

- Auth gate: `requireAdmin` 403s non-admins; admin passes. RLS-escalation regression test (a normal user cannot set their own `status`/role).
- Resolver: table-driven test over the Section 5 matrix.
- Entitlement filtering: user with a deny override doesn't see the bundle; default path unaffected.
- Admin actions write `admin_audit_log` rows.
- Run `npm run test` (Vitest) from `careervine/` before any commit.
