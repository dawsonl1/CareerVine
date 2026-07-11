# CAR-80 — Email-derived internal-account analytics exclusion (survives delete/recreate)

Branch: `dawson/posthog-account-exclusion-6a89e0` (not CAR-named → Linear hooks won't
auto-bind; status managed manually via MCP). Follow-up to CAR-60.

## Problem

CAR-60 keys internal-account exclusion on a hand-maintained list of Supabase **user
UUIDs** (`NEXT_PUBLIC_ANALYTICS_INTERNAL_USER_IDS` env var for web/server; a hardcoded
copy in the extension's `production.json`). Supabase mints a **new UUID** on every
account creation, so deleting an internal/test account and recreating it with the same
email drops it out of the list — it silently starts polluting analytics again.

Live proof: of CAR-60's 6 UUIDs, `dae9cb35-…` already resolves to **"User not found"**
(deleted); its recreated successor (`pod4cws9988@gmail.com`) had to be manually re-added
as a 6th UUID. That manual re-add is exactly the toil this ticket removes.

## Design (Option B, confirmed with Dawson 2026-07-11)

Make "internal" a property of the user, **derived from email at signup**. Match rule:
`@careervine.app` **domain** OR an **exact-email allowlist**.

### Source of truth (DB)
- `public.internal_analytics_emails(email text pk, note text, created_at)` — exact-email
  allowlist. RLS on, **no policies** (only SECURITY DEFINER fns / service_role read it).
- Seeded from the DB by CAR-60's UUIDs: `INSERT … SELECT lower(email) FROM auth.users
  WHERE id IN (<6 UUIDs>)`. The UUIDs are already committed in `production.json`, so
  **no plaintext personal emails enter git**; the domain (`@careervine.app`, public) is
  the only literal in the SQL.
- `public.is_internal_email(text) → bool` (STABLE, SECURITY DEFINER, `search_path=''`):
  `lower(email) LIKE '%@careervine.app' OR EXISTS(select 1 from internal_analytics_emails …)`.

### Distribution to the three surfaces
- **Web client** & **extension** read a JWT claim: the signup trigger mirrors the rule
  into `auth.users.raw_app_meta_data → { is_internal: true }`, which rides the session
  `User` object both surfaces already hold — **synchronous, tamper-proof, zero fetch,
  no init race** (same timing as today's `isInternalUser(user.id)`).
- **Server** (`trackServer`) only ever gets a bare UUID, so it resolves the flag with a
  cached `rpc('user_is_internal', {uid})` → `SELECT public.is_internal_email(email) FROM
  auth.users WHERE id = uid` (SECURITY DEFINER, service_role only). Authoritative,
  independent of token refresh; cached per process (internal status is immutable).

### Trigger
Extend the existing `public.handle_new_user()` (AFTER INSERT on `auth.users`): after the
existing `public.users` insert, `IF public.is_internal_email(NEW.email) THEN UPDATE
auth.users SET raw_app_meta_data = coalesce(raw_app_meta_data,'{}') || '{"is_internal":true}'
WHERE id = NEW.id; END IF;`. Runs inside the signup txn → lands in the first minted token.

### Backfill
`UPDATE auth.users SET raw_app_meta_data = … WHERE public.is_internal_email(email)` — marks
the 5 existing internal accounts. (Runs after the seed so the rule is populated.)

## Migration
`supabase/migrations/20260711180000_internal_analytics_email_rule.sql` — table + seed +
`is_internal_email` + `user_is_internal` (rpc, granted to service_role only) + extend
`handle_new_user` + backfill. Validate against prod in a rolled-back txn (rule 32) before
`supabase db push` (post-merge, rule 27).

## Code
- `careervine/src/lib/analytics/internal.ts` — replace env-var parse with async
  `isInternalUser(userId): Promise<boolean>` (uuid-guarded, cached rpc, non-throwing).
- `careervine/src/lib/analytics/server.ts` — `await isInternalUser(userId)`.
- `careervine/src/lib/analytics/client.tsx` — drop `./internal` import; check
  `user.app_metadata?.is_internal === true`.
- `careervine/src/components/auth-provider.tsx` — skip `identifyNewUser`/`user_signed_up`
  when `data.user.app_metadata?.is_internal === true`.
- `chrome-extension/src/background/background.js` — store `is_internal` in the session,
  gate `trackEvent` on it; move the session write ahead of the login track calls.
- `chrome-extension/env/production.json` — remove the `internalUserIds` array.
- `careervine/src/__tests__/analytics.test.ts` — rewrite the exclusion block for the
  async rpc path; mock `.rpc`.

## Post-merge (Claude owns unless noted)
1. `supabase db push` (validated dry then real) — rule 27.
2. `vercel env rm NEXT_PUBLIC_ANALYTICS_INTERNAL_USER_IDS production` + redeploy — rule 28.
3. **Dawson (manual-steps):** rebuild + republish the extension to the Chrome Web Store
   for the `background.js`/`production.json` change to reach users. Existing internal
   sessions pick up the claim on next token refresh (or a quick re-login).

## Out of scope / notes
- No `public.users.is_internal` column (app_metadata is the single computed mirror;
  `is_internal_email` is the authoritative rule). Keeps types.ts untouched.
- `dae9cb35-…` (deleted) simply yields no seed row; harmless.
