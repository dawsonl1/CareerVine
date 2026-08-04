# CAR-140 — Guard the privileged surfaces

Wave 1 · Straight A's (CAR-28). Retires F25, F26, F55, F12, F31, R3.5. Converts
convention-guarded privileged surfaces (admin, cron, webhooks) into CI-enforced
invariants and closes remaining hardening gaps. Branch: `dawson/car-140-88e48d`.

All six items own disjoint files (per the ticket) so this runs safely as a
parallel worktree alongside the other Wave-1 tickets.

## Recon confirmed (before writing code)

- **QStash live state**: `node scripts/qstash-schedules.mjs list` → 7 declared in sync;
  `follow-up-nudges` (`0 15 * * *`, retries 3) is live-but-undeclared. Matches the ticket exactly.
- **Route inventory**: 107 `route.ts` files; **15 hand-rolled** (not `withApiHandler`):
  3 bundle-admin-token, **9** QStash-signed (8 `cron/*` + `queue/bundle-sync` — the ticket
  said "8 incl. queue" but there are 8 cron dirs now, so 9 QStash total, 15 grand total ✓),
  `apify/run-callback` (webhook secret), `notifications/unsubscribe` (HMAC), `mcp` (oauth/jwks).
- **CAR-27 backfill is COMPLETE** — hit the prod idempotent endpoint:
  `{"encrypted":0,"alreadyEncrypted":7,"skippedRaced":0}`. All 7 gmail_connections rows carry
  `v1.` → safe to delete `encrypt-gmail-tokens/route.ts`.
- **`admin_audit_log.admin_id` is `uuid NOT NULL`, no FK** (migration `20260709140000`). Writing
  the literal string `machine:bundle-admin-token` as `admin_id` would throw 22P02, and since
  `writeAudit` swallows errors it would silently write NO row — failing the exit criterion.
  → Use a **nil-UUID sentinel** `00000000-0000-0000-0000-000000000000` for `admin_id` and carry
  the human actor label in `detail.actor = "machine:bundle-admin-token"`. Zero schema change.
- **Rate-limit lib exists** (`src/lib/rate-limit.ts` `checkRateLimit(id, {bucket,limit,window})`),
  degrades to allow-all without Upstash env. Publish driver posts **sequentially** in 50-item
  chunks (a large bundle → a few hundred requests inside a 60s window), so the coarse publish
  limit must be generous.
- **Apify supports custom webhook headers** (`headersTemplate`, docs confirmed) and
  `X-Careervine-Webhook-Secret` is not in Apify's reserved/overwritten header list → passes through.
- **process.env inventory**: exactly **46** unique vars in src+scripts. 6 are platform-injected
  (`HOME`, `NODE_ENV`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_GIT_COMMIT_MESSAGE`, `VERCEL_GIT_COMMIT_SHA`)
  → skip-list; 40 need documenting.
- Boundary greps: only `src/lib/analytics/client.tsx:18` imports `@/components` under src/lib;
  exactly 2 cross-route auth imports (ai-access + encrypt-gmail-tokens).

## Item 1 — QStash registry (ship first, tiny) · R3.5/F12

- `scripts/qstash-schedules.mjs`: add `{ name: "follow-up-nudges", path: "/api/cron/follow-up-nudges", cron: "0 15 * * *", retries: 3 }`
  to `SCHEDULES`; fix the stale "six … schedules" header (now 8).
- Refactor the script to be **import-safe**: `export const SCHEDULES`, and guard the CLI
  (token check + `main()`) behind a direct-run check
  (`process.argv[1] === fileURLToPath(import.meta.url)`) so a test can import the array
  without triggering a live fetch / `process.exit`.
- New test `src/__tests__/cron-schedules-registry.test.ts`: glob `src/app/api/cron/*/route.ts`,
  assert every cron dir has a matching `SCHEDULES` entry (path) and vice-versa (no orphan entries).
  Deleting an entry or adding a bare cron route.ts turns it red.

## Item 2 — Route-auth inventory test · F25

New `src/__tests__/route-auth-inventory.test.ts` (string/regex on file **text**, no module import):
- Glob `src/app/api/**/route.ts`.
- Each file must either contain `withApiHandler(` **or** be on an explicit `HAND_ROLLED` allowlist
  keyed by path → mechanism string. Allowlist (14 after item-3 deletion): 2 bundle-admin-token
  (ai-access, bundles/publish), 9 QStash-signed, apify/run-callback, notifications/unsubscribe, mcp.
- Under `src/app/api/admin/`, a `withApiHandler` route must also contain `requireAdmin: true`
  unless it's on the machine allowlist → removing `requireAdmin` from an admin route turns it red.
- Assert every allowlist entry maps to an existing file (stale entry → red).

## Item 3 — Machine-token parity + audit + rate limit · F25 / F55 part 1

- New `src/lib/admin-auth.ts`: move `isAuthorizedAdminToken` here (verbatim, plus its crypto imports).
  Also export a small machine-audit helper `writeMachineTokenAudit(service, {action, detail})` that
  calls `writeAudit` with `adminId = MACHINE_ACTOR_UUID` (nil UUID) and merges
  `detail.actor = "machine:bundle-admin-token"`; and a `coarseMachineRateLimit(routeBucket, limit)`
  wrapper over `checkRateLimit` keyed on a fixed id.
- Repoint importers to `@/lib/admin-auth`: `ai-access/route.ts`, `bundles/publish/route.ts`
  (drops its local definition), `src/__tests__/bundle-publish.test.ts`.
- **Delete** `src/app/api/admin/encrypt-gmail-tokens/route.ts` (CAR-27 backfill confirmed complete)
  and its allowlist entry.
- `ai-access`: after auth, `checkRateLimit` (bucket `admin-ai-access`, ~30/60s) → 429 on burst;
  on success write one audit row (`grant_ai_access`/`revoke_ai_access`, detail = {userId, sharedAccess}).
- `bundles/publish`: after auth, `checkRateLimit` (bucket `admin-bundle-publish`, generous ~1200/60s
  so the sequential chunked driver is never throttled) → 429; write audit rows only on the
  consequential lifecycle modes `begin` / `finalize` / `abort` (not per-chunk/per-resolve-step to
  avoid flooding the log). detail carries mode + slug.
- Tests (extend `bundle-publish.test.ts` or new `machine-token-auth.test.ts`): token routes write
  the expected audit row (mock service records the insert into `admin_audit_log`), and return 429
  when `checkRateLimit` (mocked) reports `allowed:false`.

## Item 4 — Lib→components inversion · F55 part 2

- Move `AnalyticsProvider` out of `src/lib/analytics/client.tsx` into new
  `src/components/analytics-provider.tsx` (it's the only thing in that file that needs `useAuth`).
  The pure functions (`track`, `trackBeforeNavigate`, `identifyNewUser`, `ensureInit`) stay in lib.
- Update the single component consumer `src/app/layout.tsx:22` to import `AnalyticsProvider` from
  the new path. All other consumers import the track functions (unchanged path).
- This also breaks the current lib↔components import cycle (auth-provider imports track from lib).
- New `src/__tests__/architecture-boundaries.test.ts`: assert (a) zero `from "@/components` under
  `src/lib`, (b) no `route.ts` imports auth from a sibling route file
  (`from "@/app/api/.../route"` naming `isAuthorizedAdminToken`). Covers item-3 + item-4 exit criteria.

## Item 5 — Apify webhook secret out of the URL · F26  (spans >24h — two phases)

**Phase 1 (this PR):**
- `src/lib/apify/client.ts`: both webhook definitions (`startProfileScrapeRun` ~:94, `startProfileSearchRun` ~:153)
  add `headersTemplate: JSON.stringify({ "X-Careervine-Webhook-Secret": <APIFY_WEBHOOK_SECRET from env> })`.
  Client reads the secret from env itself (consistent with `getApifyToken`), so callers stop threading it.
- `apify/scrape-service.ts:138,:214` and `apify/discovery.ts:222`: drop `secret=` from the callback URL
  (keep `run=`). Post-change `rg 'secret=' src/lib/apify` is empty.
- `apify/run-callback/route.ts`: read `X-Careervine-Webhook-Secret` header first via `timingSafeEqual`;
  **fall back** to the `?secret=` query param when the header is absent (protects pre-deploy in-flight
  runs whose URLs still carry the query secret). Keep env `APIFY_WEBHOOK_SECRET` unrotated in Phase 1.
- Tests: run-callback accepts a valid header, accepts a valid query (fallback), rejects both-wrong/none.

**Immediately after the prod deploy (post-merge):** run one real production profile scrape and confirm
the callback ingests via the header path — proves `headersTemplate` works before the fallback is removed.

**Phase 2 (follow-up ≥24h after deploy, Claude-owned):** remove the query fallback from run-callback
(header only); rotate `APIFY_WEBHOOK_SECRET` in Vercel prod env (rule 28) + empty-commit redeploy;
run one more real scrape to confirm end-to-end. Tracked as a Linear follow-up + scheduled task so it
isn't dropped.

## Item 6 — Regenerate .env.example · F31

- Rewrite `careervine/.env.example` from the 46-var inventory, grouped by feature, each annotated with
  its **failure mode** (what breaks when unset). Must include `BYOK_ENCRYPTION_KEY` (note: also encrypts
  Gmail OAuth tokens at rest), `NUDGE_UNSUBSCRIBE_SECRET`, `BUNDLE_ADMIN_TOKEN`, `RESEND_API_KEY`,
  `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `UPSTASH_*`, `POSTHOG_*`, `DEEPGRAM_API_KEY`, `SERPER_API_KEY`,
  `R2_PUBLIC_BASE_URL`, `QSTASH_TOKEN`. Fix the stale cron comment to point at `qstash-schedules.mjs`.
  Document the 6 platform-injected vars in a skip-list section.
- New `src/__tests__/env-example-coverage.test.ts`: every `process.env.X` read in src+scripts appears
  in `.env.example` or the documented skip-list → the file can never silently drift stale again.

## Verification & exit

- `npm run test` + `npm run build` from `careervine/` green.
- `node scripts/qstash-schedules.mjs list` exits 0, zero undeclared.
- `rg 'secret=' careervine/src/lib/apify` empty.
- Docs page (`public/docs/index.html`): no user-visible behavior change here → no copy update needed.
- Open PR titled `Guard the privileged surfaces (CAR-140)`; stop and wait for merge approval.
- Post-merge: apply migrations (none in this ticket), then the Phase-1 scrape validation + Phase-2 follow-up.
