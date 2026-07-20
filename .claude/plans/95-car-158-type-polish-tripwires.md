# CAR-158 — Type polish + convention CI tripwires

Wave 6 · T21. Retires F39, F54, F24. Blockers CAR-142 / CAR-146 / CAR-149 all Done.

Branch renamed `dawson/type-polish-tripwires-6fb309` → `dawson/CAR-158-type-polish-tripwires`
so the Linear lifecycle hooks bind.

---

## Ground truth vs the ticket

A five-agent read-only scout measured the codebase before planning. **Most of the
ticket's specifics are stale** — it was written before CAR-142/146/149 landed, and
every line number it cites has shifted. Corrections that change the work:

| Ticket claim | Reality |
| --- | --- |
| "Flip `no-explicit-any` to error" | Already **error**, inherited from `eslint-config-next/typescript`. Nothing to escalate. |
| "CAR-138 suppress-with-inventory entries in eslint.config.mjs" | Do not exist. The string `CAR-138` is absent repo-wide. The debt is **79 inline `eslint-disable-next-line` comments** in production src across 30 files. |
| "`googleapis` `calendar_v3`" | `googleapis` is not a dependency. App uses **`@googleapis/calendar ^15.0.0`**, which does export `calendar_v3`. |
| "Promote `exhaustive-deps` to error" | Rule is on at warn with **zero** active warnings, and CI already runs `--max-warnings 0`. The flip is a measured no-op. |
| "New `.from(` in `src/mcp/lib/db.ts`" (implying zero) | **45** `.from(` calls across 16 tables. CAR-151 did not collapse them. |
| "Un-awaited promise in a route handler fails CI" | **Zero** typed-promise violations exist in `src/app/api` (106 files), `src/lib` (155), `src/mcp` (27). All 277 are client-side React. |
| Cited line numbers (meetings/page, calendar/page, contact-info-header, calendar.ts, sync/route) | All wrong. Actual sites re-derived and listed below. |
| `admin/users/page.tsx:84` is debt | It is already the **exemplar** — `as { users: AdminUserListItem[] }`, type single-sourced in `@/lib/admin-users` and imported by both page and route. |
| Fetch long-tail "~60 sites" | **123** fetch call sites in browser code across 45 files. |

### The blocker the ticket never mentions

`server-only@0.0.1` exports `{react-server: empty.js, default: index.js}` and
`index.js` **throws**. Only Next's react-server layer gets the no-op. Proven
empirically against the repo's own binaries:

- **Vitest 4.1.10 fails outright** on `import "server-only"`. 77 test files touch
  candidate modules; `crypto.test.ts`, `oauth-token-crypto.test.ts` and
  `email-send.test.ts` import them unmocked.
- **`careervine-mcp` dies at startup** — it runs under plain `tsx` and transitively
  reaches 7 candidates. CI's `mcp` job is `tsc --noEmit` only, so **CI cannot catch
  this**; the server would break silently.

Verified fixes (both tested, not assumed):
- Vitest: `ssr.resolve.conditions: ['react-server']`. **`resolve.conditions` does
  NOT work** in Vitest 4 — it applies to the client environment while tests run
  through the SSR resolver. Silent trap: the config looks right and still fails.
- MCP: `tsx --conditions=react-server` (or `NODE_OPTIONS`).

### Hard exclusion

`src/lib/supabase/config.ts` holds the `SUPABASE_SERVICE_ROLE_KEY` read (:40-41) but
is reached by **47 distinct client chains** via `browser-client.ts`, plus
`src/proxy.ts` (edge middleware). It and `browser-client.ts` can never take
`server-only`; that key stays fenced by `getSupabaseEnv({server:true})` and the
existing CAR-151 eslint import fence. Same exclusion: `photo-urls.ts`,
`extension-store.ts`, `analytics/client.tsx`.

---

## Decisions (made per Dawson's "best design, more work is fine")

1. **`checksVoidReturn: {attributes: false}`.** Not an effort call. Rewriting 164
   `onClick={async () => ...}` to `onClick={() => { void handler(); }}` yields **zero**
   robustness gain — `void promise` swallows rejections identically. It trades an
   implicit floating promise for an explicit one and silences the linter. All 113
   findings that carry real defect value get resolved individually (await / void /
   catch decided per site), not blanket-prefixed.
2. **All 6 `exhaustive-deps` suppressions eliminated for real**, including the
   `speaker-resolver.tsx` `useReducer` refactor and `onboarding-flow.tsx`'s `finish`
   dependency — fixed structurally (stabilized/idempotent `finish`), never a dep-array
   patch that risks re-running onboarding completion.
3. **Tripwire (c) ships with NO baseline.** All 101 unchecked `const { data` reads get
   resolved — `must()` where control flow depends on the read, honest
   `// error-tolerated:` annotation where it is genuinely cosmetic. A baseline would
   freeze 101 items of debt behind a guard that only *looks* active.
4. **Tripwire (d) ships as a ratchet at 45**, not absolute. Migrating 45 MCP-specific
   projections into `src/lib/data` is CAR-151 territory and out of scope for a
   type-polish ticket. The guard asserts `count <= baseline` so the number can only
   fall. Stated plainly in the PR as a freeze, not a fix.
5. **F39 module set re-derived**, as the ticket itself instructs. Adds the 9
   secret-bearing modules it missed — most importantly `oauth-helpers.ts`, the actual
   `GOOGLE_CLIENT_SECRET` holder behind the entire gmail/calendar surface. Keeps the
   transitively-secret ones (`gmail.ts`, `email-send.ts`, `gmail-send-core.ts`) as
   defense-in-depth even though they read no env themselves.
6. **All four tripwires in one `scripts/check-conventions.mjs`**, per the ticket, using
   the **TypeScript compiler API** (the only *declared* parser dep) for (a)/(b)/(d)
   where AST beats line-grep. One script, one place to look. `acorn`/`@babel/parser`
   resolve today but only transitively — depending on them lets an unrelated bump
   break CI.
7. **Route-exported inferred response types** rather than hand-written shared types:
   `export type X = InferResponse<typeof GET>` cannot drift from the handler.

---

## Work

### Phase 0 — server-only enabling (must land first, independently verifiable)

Landing these with the lib edits would make a failure un-attributable.

1. Add `server-only` to `careervine/package.json` dependencies.
2. `careervine/vitest.config.ts`: `ssr.resolve.conditions: ['react-server']`.
3. `careervine-mcp/package.json`: `--conditions=react-server` on the start script.
4. Prove with exactly one module — `src/lib/r2.ts` (secret-bearing, zero client
   chains, not MCP-reachable). Then `npm run test` + `npx tsc --noEmit` + MCP boot.
5. Add an MCP **smoke check** so this class of runtime break stops being CI-invisible.

### Phase 1 — F39 boundaries

`import "server-only"` on the re-derived set. **Below any leading docblock**, not
literally line 1 — `r2.ts`, `crypto.ts`, `email-send.ts`, `gmail-send-core.ts` open
with substantial headers that stay on top.

Ticket-named, keep: `r2.ts`, `gmail.ts`, `gmail-send-core.ts`, `openai.ts`,
`deepgram.ts`, `email-send.ts`, `crypto.ts`, `apify/client.ts`,
`supabase/service-client.ts`, `supabase/server-client.ts`, `analytics/server.ts`.

Missed by the ticket, add: `oauth-helpers.ts` (GOOGLE_CLIENT_SECRET), `notify/email.ts`
(RESEND_API_KEY), `notify/tokens.ts` (NUDGE_UNSUBSCRIBE_SECRET), `qstash-verify.ts`,
`bundle-queue.ts` (QSTASH_TOKEN), `rate-limit.ts` (UPSTASH), `serper.ts`.

`admin-notify.ts` (SENDGRID_API_KEY) — SendGrid is a dead account. Flag rather than
quietly harden a path that cannot work.

Exit proof: a deliberate `'use client'` import of `gmail.ts` fails `next build`.

### Phase 2 — F54 cast hygiene

Root-cause first, since it retires the most casts per edit:

- **`getContacts` (`src/lib/data/contacts.ts:112`) returns `Promise<unknown[]>`** — the
  single root cause of 6 cast sites. Verify `CONTACTS_SELECT` against the `Contact`
  type field-by-field; if they diverge, drop the annotation and let supabase-js infer
  rather than asserting `as Contact[]` (which would relocate the lie). Confirm under
  the **`mcp` CI job** too — these return types flow into the MCP server.
- 12 of 22 production `as any` are provably dead post-CAR-142 (verified by a clean tsc
  probe). Two source comments now assert the opposite of reality and get deleted with
  their casts: `contact-experience-card.tsx:26`, `meetings/page.tsx:442`.
- Actual sites: `meetings/page.tsx` 85/87/153/367/444 · `calendar/page.tsx`
  183/185/258/261/263 (+ redundant `as Meeting[]` at 194) · `contact-info-header.tsx`
  98/363/**636** · `calendar.ts` 120/139/154/226 · `api/calendar/sync/route.ts`
  89/101/133/135/139/179/192/199/207/214.
- **Google boundary**: `import type { calendar_v3 } from "@googleapis/calendar"`. Every
  `Schema$Event` field is optional, so `sync/route.ts` 195/220/225 need a **narrowing
  type predicate on the existing `upsertable` filter** (137-144 already proves those
  invariants at runtime) — *not* scattered `!` assertions, which would swap
  compile-time `any` for runtime crashes in the sync path.
- `isGoogleApiError` helper modelled on `deepgram.ts:177`'s `errorStatus`. Note
  `sync/route.ts:101` narrows a **string sentinel we throw ourselves** (`calendar.ts:157`)
  — that one needs `err instanceof Error`, not a Google helper.
- Remove all 79 removable suppressions. **Preserve two** with non-CAR-142 rationale:
  `sanitize-email-html.ts:25` (DOMPurify/jsdom; rule 43 pins jsdom — do not touch that
  surface) and `api-handler.ts:213` (load-bearing bivariance, guarded by
  `api-handler.type-test.ts`).
- **Real defect, not debt**: `speaker-resolver.tsx:218` casts to read `industry` off
  `SimpleContact`, which has no such field and neither call site supplies. The AI
  speaker-matching prompt has **always** received `industry: undefined`. Restore it
  properly (widen `SimpleContact` + both loaders) — that was the evident intent. Check
  `public/docs/index.html` per rule 34.

### Phase 3 — F24 typed response seam

- `TResponse = unknown` as a 4th type param on the **two public overloads only**
  (`api-handler.ts` 167-193); `RouteHandler` → `Promise<NextResponse<TResponse | ApiErrorBody>>`.
  **Do not genericize the implementation signature** (201-214): its
  `HandlerContext<any,any,any,any>` bivariance is the only thing unifying the
  `User` vs `User|null` overloads under `strictFunctionTypes`.
- The true wire type is `TResponse | ApiErrorBody`, emitted from **7 sites in 4 shapes**.
  A happy-path-only `TResponse` makes clients *more* wrong (a non-2xx body would
  type-check as success), so `apiFetch<T>` is **status-discriminated** and carries a
  **no-body path** — the most common idiom is `if (!res.ok) throw`, and a wrapper that
  mandates a json parse would just get bypassed, leaving a 4th idiom.
- Audit the `data instanceof NextResponse` escape hatch (:423) before choosing the
  union — a naive signature infers `TResponse` as `NextResponse` for redirect/stream routes.
- Pilot on concrete-literal returns (`awaiting-review` `{count: number}`,
  `ai/draft-follow-ups` which already declares the exact shape at :96 but leaves it
  anonymous — which is precisely why the client falls back to `any`). Query-backed
  routes can infer `any` silently and give false confidence.
- Convert `compose-email-modal.tsx:411` and `app/page.tsx:240`. **Coordinate the
  calendar-event shape with Phase 2** — authoring it twice is worse than either alone.

### Phase 4 — typed-lint promise rules

- Add `typescript-eslint` to devDependencies **explicitly** — it is currently only
  transitive via `eslint-config-next`, so hoisting churn could silently drop type info.
- `projectService` block scoped to `src/`, enabling exactly `no-floating-promises`,
  `no-misused-promises` (`checksVoidReturn.attributes: false`), `await-thenable`.
- Verify on a **cold checkout with no `.next/`** — `tsconfig` includes `.next/types/**`.
- Resolve all 113 findings per-site. The **2 genuine bugs** are both the same defect: a
  prop declared `=> void` handed an async function and then awaited, so the await is a
  no-op, the try/catch can never fire, and the rejection escapes. Fix by widening the
  prop signatures (`=> void | Promise<void>`), then re-typecheck — `today-schedule.tsx`
  and `unified-action-list.tsx` are both on the home dashboard.
- Widen `onUiEvent` (`src/lib/ui-events.ts:69`) to clear a `voidReturnArgument` cluster
  at the source rather than at ~12 call sites.
- Flip `exhaustive-deps` to error (honest no-op) **and** eliminate all 6 disables.
- Cost: +11.6s CI (10.83s → 22.45s), marginal next to tsc + vitest + next build.

### Phase 5 — `scripts/check-conventions.mjs`

House style per `check-ui-events.mjs`: `node:fs` walk, violations as
`rel:line: text`, `✖` header naming the fix, `process.exit(1)`.

- **(a) barrel freeze + module-scope client** — both halves are already clean
  (queries.ts is 122 lines of pure re-exports; zero module-scope clients repo-wide).
  Pure regression freeze. Must not false-positive on `company-queries.ts:28-39`, a
  legitimate second lazy seam.
- **(b) rule-17 CAS** — **not reliably decidable** by regex *or* AST: 2 of 14 shape hits
  depend on dataflow (`company-helpers.ts:346-359` builds its payload one statement
  earlier). Shape-only detection + mandatory annotation opt-out; fix the 2 real
  violations, annotate the 12 pre-existing false positives in this PR. Per **rule 39**,
  the PR must **not** claim these are live production bugs without an empirical test.
- **(c) unchecked reads** — absolute, no baseline (decision 3). Must decide explicitly
  whether GoTrue/storage responses count (`cron/follow-up-nudges/route.ts:177` is
  `auth.admin.getUserById`, not PostgREST) or the baseline is inconsistent.
- **(d) `.from(` in mcp db.ts** — ratchet at 45 (decision 4).
- Wire into CI `web` job adjacent to the UI-events guard. Note `'use client'` is **not
  always line 1** (6 of 132 files put it after a block comment) — any directive check
  must tolerate leading comments.

### Phase 6 — docs + verification

- `ARCHITECTURE.md` §5 Key Patterns: server-only boundary, typed response seam,
  conventions guard.
- `public/docs/index.html` only if the speaker-resolver `industry` fix changes
  user-visible AI behavior (rule 34).
- Full `npm run test`, `npx tsc --noEmit`, `npx eslint . --max-warnings 0`,
  `npx next build` from `careervine/`; MCP `npm run typecheck` + boot smoke.
- Prove each of the 4 tripwires turns CI red on a deliberate violation, then revert.
- Rule 45: verify **web / mcp / types-drift / extension** all present and green via
  `gh run list` + `gh run view --json jobs` — not `gh pr checks` alone.

---

## Exit criteria

- `'use client'` import of a fenced module fails `next build`; vitest and MCP both
  still run.
- `npx eslint . --max-warnings 0` green with the 3 typed promise rules active and 77 of
  79 `any` suppressions gone (2 justified survivors).
- `rg 'as any'` empty over the cited files; calendar mappers compile against
  `calendar_v3` with no `: any`.
- A route returning a mismatched shape fails `tsc`; converted consumers import
  route-exported types.
- Four deliberate violations each turn CI red; clean `main` green.
- Zero unchecked `const { data` in `src/lib` + `src/app/api/cron` without annotation.
