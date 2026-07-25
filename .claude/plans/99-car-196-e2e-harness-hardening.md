# CAR-196 — E2E harness hardening: make stub denials assertable and pin the env allowlist

Blocks CAR-191 and CAR-192. Everything here is additive to the E2E tier CAR-189
stood up; no product code changes except where noted (there are none).

## Verified before planning

Every claim in the ticket was re-checked against this checkout, not taken on trust:

| Claim | Status |
| --- | --- |
| `denied` in `register.mjs` is never read | **True** — `e2e/server-stubs/register.mjs:67` pushes, `:119` reads it in a `process.on("exit")` that Playwright's SIGTERM never reaches. |
| Seven vars leak from `.env.local` | **True** — `.env.local` defines 29 keys; the 7 the ticket names are exactly the ones `appEnv` does not pin. |
| `@next/env` skips already-set vars | **True**, and `""` counts as set: `processEnv()` applies a parsed key only when `typeof initialEnv[key] === "undefined"`. So `""` *does* stop the leak — it just does not unblock flow 7, because `!process.env.UPSTASH_REDIS_REST_URL` is then true and the fail-closed buckets deny. |
| 7 fail-closed buckets | **True** — both key-save routes, `parse-profile`, `ai-draft-intro`, `ai-draft-follow-ups`, `ai-write`, `ai-followups`. `rate-limit.ts:85` gates `failClosed` on `NODE_ENV === "production"`, which `next start` always is. |
| Playwright merges rather than replaces env | **True** — `env: {...DEFAULT_ENVIRONMENT_VARIABLES, ...process.env, ...options.env}`. An allowlist has to be built by pinning, not by omission. |
| `failOnFlakyTests` exists in 1.62 | **True** — `playwright/types/test.d.ts:1269`. |
| Upstash wire shape | **Measured** — `POST {url}/pipeline`, body `[["evalsha",<sha>,3,<k1>,<k2>,"",<tokens>,<now>,<window>,<incr>]]`, response `[{result:[remaining,limit]}]`. Probed with the lockfile's own `@upstash/ratelimit`. |
| OpenAI endpoint | Ticket says "the responses endpoint"; the app actually uses `POST /v1/chat/completions` (5 call sites under `src/lib/ai-followup/`). Stub the real one. |

Also found, not in the ticket: `e2e/auth.setup.ts` imports `test` from `@playwright/test`, so the
setup project runs with **no** network guard at all — the one project that provisions state every
other spec depends on.

## 1. Server-side denials fail the run

**Built as a shared file, not the `GET /__e2e__/stub-calls` endpoint the ticket specified.** The
endpoint was implemented first and did not survive contact: `NODE_OPTIONS=--import` arms the preload
in *every* Node process the webServer command starts, so the second one to load it died with
`EADDRINUSE` and took the whole run down. Instrumenting the topology showed why the endpoint is the
wrong shape here — a single `next build` arms the module in **eleven** processes (the npx wrapper,
the `next` bin, a jest-worker thread child, six `processChild` workers, a compiled build script), and
route modules are evaluated inside those workers, so a denial can originate in any of them. One
process owning the channel would have silently dropped the rest.

So: every denial is appended to `test-results/e2e-stub-denials.log`, one plain-text line per call.
Any process can write, ordering is preserved, and a torn concurrent write still reads as a denial
(fails loudly) rather than throwing in a parser. `e2e/global-setup.ts` clears it once per run — not
the preload (eleven writers would race) and not the config's module scope (re-imported per worker).

`networkGuard` in `e2e/fixtures/test.ts` snapshots the line count before the test body and asserts
the slice since that index is empty after it, alongside the existing browser-side assertion. Per-test
windows, so one spec's denial cannot be attributed to the next — and build-phase denials, which
precede every test, fall outside all of them.

`auth.setup.ts` switches to the guarded `test` object so the setup project is covered too.

The dead `process.on("exit")` summary goes; a SIGTERM handler that logs would have to `process.exit()`
itself and race Next's own shutdown, and the readback makes it redundant.

## 2. Explicit env allowlist

`webServer.env` becomes a closed set:

- Every `process.env.X` key `src/` reads is pinned — a placeholder, or `""` for the ones that must
  read as absent.
- Every key parsed out of the `.env*` files Next would load and not already pinned is set to `""`,
  so non-app vars (`VERCEL_OIDC_TOKEN`, `SUPABASE_DB_PASSWORD`) cannot reach the server either.
- A new unit test greps `src/` for `process.env.<KEY>` and fails when a key is neither pinned nor on
  a short, commented "inherited on purpose" list (`NODE_ENV`, `PATH`, `HOME`, `CI`, the `ITEST_*`
  vars vitest owns). A new app env var then fails CI until someone decides what E2E should see.

`UPSTASH_REDIS_REST_{URL,TOKEN}` flip from absent to a stubbed placeholder, with an MSW handler for
the pipeline endpoint (item 3). That is what unblocks CAR-191 flow 7: with them absent, seven
fail-closed buckets deny in CI too, and flow 7 is 429 before a line is written. The stub always
allows and echoes the bucket's own configured limit rather than counting — CI's `retries: 2` would
otherwise let a retry exhaust a limit-5 bucket and turn a flake into a hard failure.

The config header's "deliberately ABSENT" paragraph is rewritten to say what is now true.

## 3. Handlers for the origins CAR-191 needs

Gmail `messages/:id` (get), `/modify`, `/trash`, `/untrash`, `threads/:id`, `drafts`; the Calendar
surface the app actually uses (`calendarList`, `freebusy`, `settings`, events get/insert/update/delete);
`api.openai.com/v1/chat/completions`; `api.deepgram.com/v1/projects`; `api.apify.com/v2/*`;
`api.resend.com/emails`; `google.serper.dev/{search,news}`; the Upstash pipeline. Wire bodies join the
existing fixtures in `e2e/fixtures/google-wire.mjs` (non-Google ones in a sibling module, so the
file's name keeps meaning what it says).

## 4. Smaller fixes

- `page.route` → `page.context().route` in the guard, so popups and `window.open` targets are routed.
- `failOnFlakyTests: true` — unconditional; `retries` is 0 locally so it only bites in CI.
- A `teardown` project that deletes the tenant `auth.setup.ts` provisioned, wired via the setup
  project's `teardown` property, using the `deleteTenant` that `e2e/helpers/tenant.ts:36` already
  documents and nothing calls.
- `signup-onboard.spec.ts`'s trailing cleanup becomes `try/finally` so a failed assertion still
  deletes the user.
- Stale headers: `google-wire.mjs:14` (cites `e2e/helpers/network.ts`, never committed) and `:91`
  (`STUBBED_ORIGINS`, imported nowhere); `register.mjs:65` ("see below"); `CONVENTIONS.md:401-408`.

## Verified

1. `npx playwright test` — **6 passed** with `.env.local` present, and 6 passed with it moved aside.
   Zero denials either way, so local and CI now exercise the same app.
2. Removed the Gmail `labels` handler — the exact endpoint behind the historical false green. The run
   went **red**, naming it: `the SERVER attempted un-stubbed external requests` →
   `GET https://gmail.googleapis.com/gmail/v1/users/me/labels`. Handler restored.
3. Fail-closed buckets unblocked: `PUT /api/settings/openai-key` returns **200**, not 429 — the real
   limiter ran against the Upstash stub and allowed. This is CAR-191 flow 7's blocker, cleared.
4. `npm run test`, `npm run lint`, `npx tsc --noEmit`, `npm run build`.

The denial log found a bug in this ticket's own work while verifying it: `validateOpenAIKey` uses the
Responses API, not chat/completions, and the missing handler showed up as a 60-second test timeout
(the OpenAI SDK retries a 599 with backoff). The log named the endpoint immediately. Both OpenAI APIs
are stubbed now, plus Deepgram `/v1/listen`, found in the same sweep.
