# CAR-46 — Duplicate-email signup: tell the user the account exists

## Problem

Signing up with an already-registered email shows the "Check your email" screen, but no email arrives and the user is never told an account exists.

**Root cause:** with email confirmations enabled, Supabase `auth.signUp()` deliberately returns success for already-registered emails (anti-enumeration) — a fake user whose `identities` array is empty. `signUp()` in `careervine/src/components/auth-provider.tsx` only checks `error`, so the UI treats it as a fresh signup. It also fires the `user_signed_up` analytics event for these non-signups.

## Fix

1. **`auth-provider.tsx` — `signUp()`**
   - After a non-error response, check `data.user?.identities?.length === 0` → return `{ error: "...", existingAccount: true }` and skip the `user_signed_up` track call.
   - Widen the `signUp` return type to `{ error?: string; existingAccount?: boolean }`.
   - Genuinely-new users and existing-but-unconfirmed users (Supabase re-sends the confirmation email, `identities` non-empty) keep the success path → check-email screen.

2. **`auth-form.tsx` — signup submit handler**
   - On `existingAccount`, show an inline notice: "An account with this email already exists." with actions to **Sign in** (switches mode, email preserved — it already is via shared `formData`) and **Forgot password?**.

3. **Tests** — new Vitest file covering the `signUp` decision logic: error passthrough, empty-identities → existingAccount (no track), normal signup → success + track.

## Non-goals

- No change to Supabase project settings or server-side auth.
- Accepting the (mild) email-enumeration signal — the reset-password and sign-in flows are the product's chosen UX priority here.

## Verification

- `npm run test` from `careervine/`.
- `npm run build`.
