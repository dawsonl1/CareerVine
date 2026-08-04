# CAR-41 — Per-user rate limiting on /api/extension/parse-profile

Implements the amended (audited) design from the ticket: reuse the Upstash sliding-window
pattern from `src/mcp/rate-limit.ts` (CAR-13) as one shared limiter, wire it into
`withApiHandler` as opt-in config, and apply it to parse-profile at 60/hour/user.
No migration, no new vendor.

**Prerequisite verified:** `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` exist in
Vercel Production (confirmed via `vercel env ls production`, both present, updated 1d ago).
The limiter will be live on deploy, not a silent no-op.

## 1. Shared limiter — `careervine/src/lib/rate-limit.ts`

- `checkRateLimit(userId, { bucket, limit, window })` → `{ allowed, remaining, resetAt }`
  (`resetAt` = epoch ms, `null` when the limiter is disabled).
- Sliding window via `@upstash/ratelimit`; one `Ratelimit` instance cached per bucket;
  the Upstash key prefix **is** the bucket name.
- Graceful no-op (allow) when the env vars are absent — logged once per process, matching
  the MCP limiter's degrade behavior.
- Migrate the MCP route: `src/mcp/rate-limit.ts` is deleted; `/api/mcp` calls the shared
  helper with `bucket: "careervine-mcp", limit: 100, window: "1 h"` — identical Redis keys,
  so in-flight windows carry over. Same 429 + `Retry-After` response shape as today.
- Out of scope (noted in ticket): the in-memory `checkSaveRateLimit` copies.

## 2. Handler wiring — `careervine/src/lib/api-handler.ts`

- New opt-in `RouteConfig.rateLimit?: { bucket, limit, window }`.
- Check runs immediately after auth resolves, before body parse. `authOptional` with no
  user → skip the check.
- On exceeded, **return the 429 `NextResponse` directly** (never `throw ApiError` — the
  catch path can't carry the `Retry-After` header). Body:
  `{ error, code: "rate_limited", resetAt }`; headers: `Retry-After` + CORS when `cors`.
- parse-profile route opts in: `rateLimit: { bucket: "careervine-parse-profile", limit: 60, window: "1 h" }`.
  Single tier for everyone — the shared-key-stricter variant was dropped by the audit
  (shared-vs-BYO is decided inside `runWithOpenAIFallback`, unenforceable at handler level).

## 3. Extension surface

- Thread `resetAt` through the existing error chain (it currently carries only
  message/code/status): `background.js` `authenticatedPost` + `handleParseProfile` →
  `content.js` `parseError` → panel `handleParseError`.
- Panel copy for `status === 429 && code === "rate_limited"`: "You've hit the hourly
  import limit — try again in N minutes" (N from `resetAt`, minimum 1). Extracted as a pure
  helper `panel-app/src/rate-limit-copy.ts` so it's unit-testable; rendered through the
  existing `errorText` state (both render sites — empty-state block and status div —
  already display it). `mapAiFailure` untouched: 429 ≠ 402 → returns null → errorText path.
- Rebuild the panel bundle (`cd chrome-extension/panel-app && npm run build`).

## 4. Tests (Vitest, all mocked — no live Redis)

- `lib/rate-limit.ts`: mocked `@upstash/ratelimit`/`@upstash/redis` — allow/deny mapping,
  per-bucket instance caching + prefix, graceful no-op without env, one-time log.
- `api-handler.test.ts` additions: 429 body shape + `Retry-After` + CORS headers on
  exceeded, under-limit passthrough, `authOptional`+no-user skip, no rateLimit config →
  limiter never called.
- Extension copy helper test via a new `@panel` vitest alias (mirrors the existing `@ext`
  pattern): minutes computation, minimum bound, and `mapAiFailure(429, "rate_limited") === null`.

## 5. Rollout

- Env already present (verified above) — merge deploys via Vercel; watch logs for 429s and
  tune the 60/hr limit if real users hit it.

## Acceptance criteria (from ticket)

- >60 parses/hour from one user → 429 with clear panel UX incl. minutes-until-reset;
  under-limit unaffected.
- MCP route and parse-profile share one limiter implementation.
- Limiter degrades gracefully (allow + one log line) when Redis env is absent.
