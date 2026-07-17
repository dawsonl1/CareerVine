# CAR-149 — API handler & route conventions sweep

Wave 3 · T12 of the Straight A's program (CAR-28). Retires findings F20, F43, F44,
F45, F46, F47, F48. One consolidated sweep so the conventions doc records settled
shapes, not drift. Owned files are disjoint from same-wave tickets.

## Current-state facts established during exploration

- `rate-limit.ts` already carries the CAR-143 `failClosed` flag + fail-closed deny
  paths, and the wrapper already emits the rate-limit 429 with `Retry-After`. So
  F44's failClosed groundwork is done — remaining F44 work is the settings-route
  migration, the fail-**open** guardrail event, the two new limits, and calendar.
- All 9 QStash consumers use the identical 5-line inline verify block
  (`new Receiver({... || ""})` + `receiver.verify` + catch→401).
- The `.or()` audit: every user-input `.or()` site EXCEPT resolve-contact already
  sanitizes (`sanitizeForPostgrest` in check-duplicate/import; metachar-strip in
  admin routes). Only `resolve-contact` interpolates a raw `email`.
- 8 of the 9 `Number(params.*)` sites already hand-roll a NaN guard; only
  `email-follow-ups/[id]` is unguarded. paramsSchema unifies all 9.
- F46: zero production client callsites read body `.ok` (verified by subagent) —
  only `ai-request-access-route.test.ts` asserts the body shape and must update.
- Test files ARE type-checked (`tsconfig` includes `**/*.ts`), so a
  `@ts-expect-error` file is a real regression gate under `tsc`/`next build`.
- `setup.ts` is empty; cron tests mock `@upstash/qstash` Receiver, so the new
  env-key guard needs dummy QSTASH keys set globally in setup.

## F20 — authOptional truth (compile-time only)

`src/lib/api-handler.ts`:
- Split `withApiHandler` into **two overloads** + a broad impl signature:
  - `authOptional: true` → handler ctx `user: User | null`
  - `authOptional?: false` (or absent) → `user: User`
- Add a third generic `TParams` (also serves F47) and `HandlerContext<TBody,
  TQuery, TParams, TUser>` with `user: TUser`, `params: TParams`.
- Impl: `let user: User | null`; delete `null as unknown as User` (→ `user = null`)
  and the four `(user as User | null)` self-casts (→ `user`).
- New `src/__tests__/api-handler.type-test.ts` (no `.test.ts` suffix → not run by
  vitest, checked by tsc): `@ts-expect-error` that authOptional `user.id` is
  possibly-null; non-authOptional `user.id` compiles clean.
- Header: document the curated-error rule (F45), one-success-shape rule (F46),
  and paramsSchema (F47).

Risk: 14 routes pass explicit `<TBody>` type args; 5 routes are `authOptional:
true`. Typecheck the whole app immediately after this change before touching routes.

## F43 — QStash chokepoint

- New `src/lib/qstash-verify.ts`: `verifyQStash(req)` →
  `{ ok:true; body } | { ok:false; response }`. Memoized Receiver keyed on the key
  values; **env-unset → 401** (explicit refuse), verify-fail → 401. Returns the
  already-read body so callers don't re-`req.text()`. `resetQStashReceiverForTests()`.
- Convert all 9 consumers (8 cron + queue/bundle-sync) to the wrapper; delete each
  `new Receiver`. `rg 'new Receiver' src/app/api` → 0.
- `setup.ts`: set dummy `QSTASH_CURRENT/NEXT_SIGNING_KEY` so existing cron tests
  (which mock the Receiver class) pass the new env guard.
- New `src/__tests__/qstash-verify.test.ts`: unsigned→401 (handler never runs),
  verified→ok+body, unset-keys→401 (env saved/restored + memo reset).
- New `src/__tests__/cron-guard.test.ts`: `withCronGuard` catch emits
  `trackCronError` + returns 500.
- Update the comment in `route-auth-inventory.test.ts` (HAND_ROLLED map unchanged).

## F44 — rate-limit idiom

- `rate-limit.ts`: env-unset `console.warn`→`console.error`; add
  `reportDegradeOnce(bucket)` firing a `rate_limit_degraded` guardrail event on the
  **fail-open** branch (once per bucket/process); reset the set in
  `resetRateLimitersForTests`.
- `events.ts`: add `rate_limit_degraded: { bucket: string }` under Guardrails.
- `settings/openai-key` + `settings/deepgram-key`: delete the module-level
  `saveAttempts` Map + `checkSaveRateLimit`; add `rateLimit: { bucket, limit:5,
  window:"10 m", failClosed:true }` to the **PUT** config only (GET/DELETE unlimited).
- `suggestions/generate`: add a modest per-user `rateLimit` (no failClosed — it
  degrades to rule-based; size generous to real usage).
- `contacts/[id]/scrape`: add a modest per-user `rateLimit` (also gets paramsSchema).
- `calendar/sync`: add `Retry-After` to the cooldown 429. Extend `ApiError` with an
  optional 4th `headers` arg; the wrapper's ApiError catch merges them.
- `rg 'new Map' src/app/api` → 0. Add rate-limit test: fail-open guardrail + the
  failClosed-with-env-unset deny (exit criterion).
- **429 scope note:** Retry-After added to the throttling 429s this ticket owns
  (wrapper rate-limit ✓, calendar cooldown, settings→wrapper). Confirm-route send-cap
  429 gets Retry-After = seconds-to-daily-reset iff the cap is UTC-day based (verify
  in email-send). MCP/admin machine-token 429s are separate domains, left as-is.

## F45 — curated errors

Replace interpolated DB `error.message` with curated copy; raw error → `console.error`:
- `bundles/subscribe/route.ts:80,91`
- `target-companies/bulk-import/route.ts:84,92` (reaches client via the `errors[]`)
- `apify/resolver.ts:94`
State the rule in the api-handler.ts header.

## F46 — one success shape

Rename `ok: true` → `success: true` in the 5 non-admin outliers (analytics/milestones,
ai/request-access ×2, extension/ping, gmail/follow-ups/confirm ×2, apify/run-callback)
and update `ai-request-access-route.test.ts` (5 assertions). Document in the header.
Admin routes keep their own convention.

## F47 + F48 — params validation, colocation, injection

- Add `idParamSchema = z.object({ id: z.coerce.number().int().positive() })` to
  api-schemas.ts.
- Convert the 9 non-admin `Number(params.id)` sites to `paramsSchema: idParamSchema`
  + `params.id` (number); delete the hand-rolled guards. (Admin `[contactId]` route
  left to its own ticket.)
- **Soften** the api-schemas.ts header to bless route-colocated schemas (matches
  admin routes' blessed colocation), rather than moving the 3 inline schemas — the
  header currently over-claims "all API routes."
- `gmailAiWriteResolveContactQuerySchema` → `z.string().email()`; in resolve-contact,
  `sanitizeForPostgrest(email)` before the `.or()` interpolation. Non-email input is
  rejected at the query-schema boundary (wrapper's uniform **400**; the exit
  criterion's "422" is met as a 4xx rejection — 400 chosen for cross-route
  consistency over a bespoke per-route status).
- Tests: api-handler.test.ts paramsSchema (valid→number, bad→400); resolve-contact
  non-email→400 + `.or()` receives sanitized value.

## Verification

`npm run typecheck`, `npm run test`, `npm run build` from `careervine/`. Then
`/deep-review-pr` on the PR and fix every confirmed finding (incl. nits) in this PR.
