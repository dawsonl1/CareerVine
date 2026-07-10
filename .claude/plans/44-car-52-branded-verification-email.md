# CAR-52 — Branded verification email + confirm-link auto-login

## Problem

Email confirmation is kept (rescoped v2) but broken as a front door: the browser client is PKCE (`@supabase/ssr` default), `signUp` passes no `emailRedirectTo`, and no `/auth/confirm` route exists — so a confirm click lands the user on `/` unauthenticated. The email itself is the stock Supabase template sent from Supabase's built-in SMTP (2 emails/hour cap).

## Code changes (this repo)

1. **`src/app/auth/confirm/route.ts`** (new) — GET route handler:
   - Parse `token_hash`, `type` (EmailOtpType), optional `next`.
   - Server-side `supabase.auth.verifyOtp({ type, token_hash })` via a `createServerClient` wired to request/response cookies (canonical @supabase/ssr pattern; works cross-tab and cross-device).
   - Success → track `user_email_verified` (server analytics, signup type only) → redirect to sanitized `next` (relative-path-only, default `/`). Failure/missing params → redirect to `/auth?error=confirm-expired`.
2. **`src/lib/supabase/server-client.ts`** — pass cookie `options` through in `setAll` (currently dropped), so the session cookies minted by `verifyOtp` get their intended attributes (maxAge etc.) instead of degrading to session cookies.
3. **`src/components/auth-provider.tsx`**:
   - `signUp`: add `emailRedirectTo: ${origin}/auth/confirm`.
   - `resetPassword`: `redirectTo` → `${origin}/auth/confirm?next=/reset-password` (fixes the reset-password hash-token/setTimeout fragility noted in the ticket — recovery now verifies server-side and lands with a real session).
   - New `resendConfirmation(email)` → `supabase.auth.resend({ type: "signup", ... })` — without this, an expired link (OTP TTL) permanently strands an unconfirmed account.
4. **`src/components/auth-form.tsx`**:
   - `check-email` copy: set the expectation that clicking the link signs you straight in; add a rate-limited "Resend email" button.
   - Surface `?error=confirm-expired` (via `src/app/auth/page.tsx` param) as a friendly "link expired, sign in or resend" notice.
5. **`src/lib/analytics/events.ts`** — add `user_email_verified` (CAR-50 funnel: signup → verified).
6. **`scripts/configure-auth-emails.mjs`** (new, ops) — idempotent Supabase Management API patcher: `--apply` sets branded confirmation + recovery templates (token_hash link form), subjects, OTP expiry; `--revert` restores stock `{{ .ConfirmationURL }}` templates. Keeps the dashboard-side config reproducible in-repo.

## Infra changes (Supabase Management API + SendGrid + Cloudflare — no dashboard clicking)

- **SendGrid domain auth for `careervine.app`**: create via SendGrid API, add returned CNAMEs to Cloudflare zone `careervine.app`, validate. Sender: `CareerVine <noreply@careervine.app>`.
- **Custom SMTP on Supabase** (`PATCH /v1/projects/{ref}/config/auth`): smtp.sendgrid.net:587, user `apikey`, pass `$SENDGRID_API_KEY`; bump `rate_limit_email_sent` 2 → 30/hr; `mailer_otp_exp` 3600 → 86400 (fewer dead expired links).
- **Templates**: branded HTML (inline-styled, table layout, CareerVine green + Sprout wordmark) for **confirmation** and **recovery**, link form `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup` (+ `&next=/reset-password` for recovery). SiteURL form (not RedirectTo) so links never silently fall back to a path-less URL; local dev's own stack substitutes its own SiteURL.
- **Redirect allowlist**: add `http://localhost:3000/**` (prod entries already cover `/auth/confirm`).

## Sequencing (the only risky bit)

The new template links point at `/auth/confirm`, which 404s on prod until this PR deploys. So: SMTP + domain auth + allowlist go live immediately (safe under the old template). Templates are applied **temporarily for the pre-merge E2E test, then reverted**; final `--apply` runs right after the merge (same pattern as post-merge migrations).

## Verification

- Vitest: confirm-route unit tests (success redirect + cookie set, invalid token, open-redirect rejection on `next`, missing params), signUp `emailRedirectTo`, resend. Full suite green.
- **Real E2E before PR**: `next dev` with `NEXT_PUBLIC_SUPABASE_USE_PROD=true`, sign up with `dawsonlpitcher+car52test@gmail.com`, receive the branded email (Gmail MCP), follow the token_hash link against localhost `/auth/confirm`, assert authenticated dashboard. Then revert templates + clean up the test user.
- Post-merge: re-apply templates, repeat E2E against prod proper.

## Out of scope

Google sign-in; removing verification; CAR-50's onboarding UI itself (confirm route just lands on `/` where CAR-50 will take over).
