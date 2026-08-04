# CAR-181: re-assert the security lockdowns CAR-178's blanket GRANT ALL reversed

## Problem (live on prod)

`20260724091000_car178_explicit_postgrest_grants.sql` ran `GRANT ALL ON ALL TABLES/FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role` (plus `ALTER DEFAULT PRIVILEGES`). Necessary — a fresh stack had no DML grants — but too broad: it re-granted privileges ~14 earlier migrations had deliberately REVOKED, and because it granted the roles explicitly (not via PUBLIC), the original `REVOKE ... FROM PUBLIC` lockdowns no longer cover them.

Most severe: two SECURITY DEFINER write functions became **anon-executable** (RLS bypassed) — `apply_bundle_resolutions` (UPDATE bundle_prospects) and `replace_transcript_segments` (DELETE+INSERT transcript_segments) — i.e. unauthenticated cross-tenant write primitives. Verified via `has_function_privilege`.

## Fix

New migration `20260724100000_car181_reassert_grant_lockdowns.sql`, running after CAR-178:

- **Functions**: REVOKE anon EXECUTE on all 11 deliberately-locked functions; also REVOKE authenticated on the 4 service-only ones (`apply_bundle_resolutions`, `increment_ai_shared_usage`, `user_is_internal`, `is_internal_email`). Authenticated keeps EXECUTE on the authenticated-intended ones (`replace_transcript_segments`, alumni/stats/pipeline RPCs).
- **Tables (service-only)**: REVOKE ALL from anon+authenticated on `user_api_keys`, `user_ai_access`, `bundle_access_overrides`, `admin_audit_log`. REVOKE INSERT/UPDATE/DELETE (keep SELECT) on `ai_shared_usage`.
- **Column-scoped**: `gmail_connections` — REVOKE ALL, re-GRANT SELECT on the 6 non-secret metadata columns only (token columns stay unreadable). `users` — REVOKE full UPDATE, re-GRANT the 9 profile columns; REVOKE ALL from anon.
- **Future footgun**: `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM anon` so future functions don't auto-expose to anon.

## Guard

New `src/__integration__/grant-lockdowns.itest.ts` asserts the intended grant end-state against the real DB: anon can't execute any locked function; service-only fns not executable by authenticated; gmail token columns unreadable by authenticated (metadata readable); the table write locks; users profile-only UPDATE; and a general invariant — **no un-allowlisted SECURITY DEFINER function is anon-executable** (allowlist: `handle_new_user` trigger, `bundle_visible_to` RLS helper, both pre-existing + benign). Mutation-tested: re-granting anon on `apply_bundle_resolutions` turns it red.

## Verification

- `supabase db reset` applies the migration cleanly against the full chain.
- Privilege sweep confirms every hole closed, every intended access preserved.
- `npm run test:integration` 30 passed (incl 5 new); `npm run test`, typecheck, lint, build green.
- Post-merge: apply to prod (dry-run → push), re-run the anon-EXECUTE sweep against prod.
