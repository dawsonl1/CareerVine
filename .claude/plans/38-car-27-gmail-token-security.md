# CAR-27 — Encrypt Gmail OAuth tokens at rest + lock down RLS

**Ticket:** [CAR-27](https://linear.app/career-vine/issue/CAR-27) — `gmail_connections` stores Google OAuth `access_token`/`refresh_token` as plaintext TEXT, and the authenticated SELECT RLS policy lets the **browser** Supabase client read them. Anyone with a user session (XSS, malicious extension, shared-machine devtools) can exfiltrate live Gmail tokens.

**Pre-verified facts** (three read-only audit agents + direct inspection, 2026-07-10):

- All token reads/writes are server-side via the **service client**. Complete inventory:
  - Writes: `api/gmail/callback/route.ts:68` (upsert), `lib/oauth-helpers.ts` `doRefresh` (updates `access_token` only). `lib/gmail.ts` `exchangeCodeForTokens` is **dead code** (zero callers — the callback route does its own exchange).
  - Reads: `lib/gmail.ts` `getGmailClient` + `revokeAccess`, `lib/calendar.ts` `getCalendarClient`, `lib/oauth-helpers.ts` `refreshTokenIfNeeded` lock-wait re-read.
- The **only** browser-client access is `queries.ts` `getGmailConnection` — selects `id, gmail_address, last_gmail_sync_at, created_at`, filters on `user_id`, called from 3 `"use client"` components. No client mutations, no realtime subscriptions, no `select("*")` on the table anywhere, no extension access, no SQL functions/views touching tokens.
- `crypto.ts` (AES-256-GCM, `v1.` prefix format) exists from plan 29; `BYOK_ENCRYPTION_KEY` confirmed present in Vercel production.
- Tests: `gmail-sync`, `gmail-drafts`, `calendar-sync-route` seed plaintext tokens but mock `oauth-helpers`/`calendar` — they pass unchanged under plaintext-tolerant decryption. No global test key; per-file `BYOK_ENCRYPTION_KEY` setup is the established pattern (`crypto.test.ts`).

## 1. Migration — `supabase/migrations/20260710100000_lock_down_gmail_connection_tokens.sql`

Column-level grants (same lockdown philosophy as `user_api_keys`, but the client still needs metadata):

- Drop the client INSERT/UPDATE/DELETE policies (all mutations are service-role; policies without grants are dead weight). Keep the SELECT policy — it still scopes rows.
- `REVOKE ALL ON gmail_connections FROM anon, authenticated;`
- `GRANT SELECT (id, user_id, gmail_address, last_gmail_sync_at, created_at) ON gmail_connections TO authenticated;`

`user_id` must stay in the grant: both the RLS predicate and the client's `.eq("user_id", …)` filter require SELECT on it. Token columns, `calendar_sync_token`, and all calendar prefs become server-only (the calendar UI already reads them via `/api/gmail/connection`, which is service-role). No schema shape change → no `database.types.ts` regen.

## 2. Token crypto wrapper — `lib/oauth-helpers.ts`

- `encryptOAuthToken(plaintext)` → `encryptSecret`.
- `decryptOAuthToken(value)` → starts with `v1.` ? `decryptSecret(value)` : value as-is (legacy plaintext, tolerated so the deploy→backfill window can't break logins; also keeps existing tests green). `CryptoError` on real ciphertext propagates — with a misconfigured key there is no graceful fallback for OAuth tokens.

Lives in `oauth-helpers.ts` because both `gmail.ts` and `calendar.ts` already import from it.

## 3. Update the seven live call sites

- **Encrypt on write:** callback-route upsert (both tokens), `doRefresh` update (`access_token`).
- **Decrypt on read:** `getGmailClient`, `getCalendarClient`, `refreshTokenIfNeeded` lock-wait re-read, `revokeAccess`.
- **Delete** dead `exchangeCodeForTokens` from `gmail.ts`.

## 4. Backfill — `POST /api/admin/encrypt-gmail-tokens`

Machine route in the established admin style (`ai-access`): bearer `BUNDLE_ADMIN_TOKEN`, service client, no user session. Iterates all rows; for each token lacking the `v1.` prefix, rewrites it encrypted. Idempotent; returns `{ encrypted, alreadyEncrypted }`.

- **Race guard:** a concurrent token refresh could write a *newer* encrypted token between our read and write. Guard each update with `.eq("access_token", <original plaintext>)` CAS — and per **rule 17**, detect success via `{ count: "exact" }`, never `.select()` on the filtered-modified column.
- Kept permanently (idempotent re-runs double as verification), matching the ai-access precedent.

## 5. Tests (`npm run test` from `careervine/`)

- New `oauth-token-crypto.test.ts`: round-trip via wrapper, plaintext pass-through, refresh writes ciphertext (real crypto, per-file `BYOK_ENCRYPTION_KEY` à la `crypto.test.ts`).
- New backfill-route test: 401 without bearer; encrypts plaintext rows; skips `v1.` rows; CAS-miss row skipped without error.
- Existing gmail/calendar tests: expected to pass unchanged (audited); fix if reality disagrees.

## 6. Land & deploy (worktree → PR path)

1. Branch `dawson/car-27-plan-3cca53` (this worktree). Implement, test, push, `gh pr create` with `(CAR-27)` in title → **stop for Dawson's merge approval**.
2. After merge (standing authority, rules 27/16/29): `supabase db push --dry-run` → review → `push`; Vercel auto-deploys; then invoke the backfill route once at `https://www.careervine.app` and confirm counts; behavior-verify Gmail connection status still renders (metadata grant path).

**Explicitly out of scope:** `calendar_sync_token` encryption (a sync cursor, not a credential — now server-only anyway); README (not user-facing); key rotation story (same tradeoff as existing BYOK keys). **Manual steps for Dawson: none** — only the PR merge decision.
