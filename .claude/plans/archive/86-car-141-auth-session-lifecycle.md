# CAR-141 — Fix the auth/session lifecycle

Wave 1 · T4 of the Straight A's program (CAR-28). Retires audit findings R1.1–R1.5.

## Live bug being fixed

`/admin` 500s and force-logs-out the admin when the access token is expired: `admin/layout.tsx` calls `getUser()` during render, `@supabase/ssr` tries to write the rotated refresh-token cookies from a Server Component (read-only cookie store → ReadonlyRequestCookiesError), and the rotated refresh token is burned — GoTrue reuse detection then kills the whole session.

## Changes

### 1. R1.1 — `careervine/src/proxy.ts` (Next 16 middleware) + guarded `setAll`

- Create `careervine/src/proxy.ts` (Next 16.1.6 renamed `middleware.ts` → `proxy.ts`) implementing the canonical @supabase/ssr updateSession pattern:
  - `createServerClient` bound to `request.cookies` / a `NextResponse.next({ request })` response.
  - `getAll` reads request cookies; `setAll` writes them onto both the request (for downstream RSC) and the response (rotated cookies reach the browser).
  - `await supabase.auth.getUser()` to force the refresh in a context that CAN write cookies.
  - Matcher excludes `_next/static`, `_next/image`, `favicon.ico`, and public asset extensions (svg/png/jpg/jpeg/gif/webp).
- Wrap `setAll` in `src/lib/supabase/server-client.ts:32-34` in try/catch with the standard "the proxy refreshes sessions, Server Components can safely ignore this" comment — **preserving the options pass-through** (the existing comment explains why options matter).

### 2. R1.4 — 8-char password minimum

- PATCH GoTrue config via Supabase Management API: `password_min_length` 6→8 (project `iycrlwqjetkwaauzxrhd`; token from keychain per the supabase-management-api memory). Read back to verify.
- `reset-password/page.tsx`: `length < 6`→`< 8` + message, placeholder "At least 8 characters", `minLength={8}`.
- Verify `rg 'least 6|minLength={6}|length < 6' careervine/src` comes back empty (signup/settings/admin already enforce 8).

### 3. R1.5 — unified recovery flow (strict order)

- **(a) first**: `api/admin/users/[id]/password/route.ts` mode `link`: stop returning `data.properties.action_link` (implicit-grant hash-token link straight at /reset-password). Instead build `{origin}/auth/confirm?token_hash={data.properties.hashed_token}&type=recovery&next=/reset-password` — same shape as the branded recovery email (`scripts/configure-auth-emails.mjs:79`). Drop the now-pointless `redirectTo` option if unused by generateLink semantics (keep call valid).
- **(b) then**: simplify `reset-password/page.tsx:18-47` to a single awaited `getSession()` check — delete the `PASSWORD_RECOVERY` onAuthStateChange branch and the 2000ms setTimeout retry. Both entry points (self-serve email + admin link) now land via `/auth/confirm` verifyOtp, which mints real cookies server-side before the page loads, so the session is deterministically present.

### 4. R1.2 — truthful consent + scope invariant

- `oauth/consent/page.tsx`: delete dead `scope` field from `AuthDetails` (line 15; only ever populated by the cast at line 52, rendered nowhere). Reword the bullet list to state the real grant: while connected, the client acts as you across your CareerVine account (contacts, outreach, email drafts/sends within caps, interactions, calendar) — no per-scope gating. No em dashes in the rendered copy (rule 35).
- `src/mcp/verify-token.ts:47`: invariant comment on `scopes: []` — scopes gate nothing today; introducing granular scopes requires changing the Supabase AS config and this check together.
- `public/docs/index.html` (~line 890, "Locked down like the rest of the app" note): replace the false "scoped per request … exact scopes" claim with the truthful consent statement. Rule 34 (docs in same PR) + rule 35 (no em dashes).

### 5. R1.3 — auth tests (Vitest, jsdom, patterns from `auth-signup-existing-email.test.tsx` / `sign-out-redirect.test.tsx`; don't duplicate their coverage)

New test files under `careervine/src/__tests__/`:

- `oauth-consent.test.tsx`:
  - approve calls `approveAuthorization` with the fetched authorizationId and follows `redirect_url`
  - deny path calls `denyAuthorization`
  - unauthenticated → inline sign-in form, `signIn` wired
  - error state rendered from getAuthorizationDetails failure
- `reset-password.test.tsx`:
  - sessionReady gating (form hidden until session check resolves)
  - no session → invalid-link error state
  - 8-char validation + mismatch validation
  - submit calls `updateUser({ password })`; Supabase error surfaced
- `auth-provider-signin-banned.test.tsx`: `signIn` translates GoTrue "banned" errors into the suspended-account message; normal errors pass through.
- `admin-password-link.test.ts` (route-level): mode `link` returns an action link pointing at `/auth/confirm?token_hash=...&type=recovery&next=/reset-password`.

## Exit criteria (from the ticket)

- proxy.ts exists with refresh-and-rewrite + matcher; setAll guarded; /admin never 500s on an expired-but-refreshable token.
- Management API read-back shows `password_min_length: 8`; the rg probe is empty.
- Admin link points at /auth/confirm (route test); reset-password has no onAuthStateChange/setTimeout.
- All listed test behaviors covered; `npm run test` + `next build` green.

## Order of work

1. proxy.ts + server-client guard → build
2. recovery flow (a) then (b)
3. 8-char UI + Management API PATCH
4. consent copy + invariant comment + docs
5. tests, full suite, build
6. PR sync from main, `gh pr create` with `(CAR-141)` title
