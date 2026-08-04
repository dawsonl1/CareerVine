# CAR-189 — Stand up the Playwright E2E tier

Wave 2 of CAR-182. Real browser, real Postgres, three core flows, CI job.

Everything load-bearing below was **proved empirically against the running local
stack before this plan was written** — see "Validation already done".

---

## Validation already done (not assumptions)

| Claim | How it was proved |
| --- | --- |
| `next start` honours `NODE_OPTIONS=--import` | Built the app against the local stack, started it with a preload; the preload logged from inside the Next process (parent **and** its forked child) and the app served 200. |
| MSW in that preload intercepts the **server-side** Gmail call | `POST /api/gmail/send` returned `{"messageId":"e2e-msg-1","threadId":"e2e-thread-1"}` — the fixture, not Google. |
| It intercepts every HTTP client the app uses | Probe covered `node-fetch` v3 (what `@googleapis/*` actually uses via gaxios 7), global `fetch`/undici (OpenAI SDK), and raw `https.request`. All three intercepted. |
| Unstubbed external origins can be **blocked**, not just logged | MSW's `onUnhandledRequest: 'error'` only *prints*; the probe's calls reached the real Resend/OpenAI/Apify and came back 401. A trailing `http.all('*')` handler returning 599 blocks them for real. |
| Loopback still works | `http://127.0.0.1:54321/rest/v1/` passed through to the live stack. |
| A session can be minted without touching the login UI | `admin.generateLink({type:'magiclink'})` → `GET /auth/confirm?token_hash=…` set `sb-127-auth-token` and the follow-up API call authenticated. |
| The full send path writes what we want to assert | `email_messages` row (`direction: outbound`) + `interactions` row (`Sent: <subject>`) both landed. |

---

## Deviations from the ticket, and why

**1. `page.route()` cannot do the job the ticket assigns it.**
The ticket's §3 stubs `googleapis.com`, `api.openai.com`, `api.resend.com` and Apify
with `page.route()`. Those calls are made **server-side** by the Next process
(`gmail-send-core.ts:142` calls `@googleapis/gmail`), and `page.route()` only sees
browser traffic. Stubbing at the browser would mean intercepting
`POST /api/gmail/send` itself, which skips every server-side DB write — exactly the
thing this tier exists to assert.

So interception is **two-layered**:

- **Server side** — MSW `setupServer` in a `--import` preload on the `next start`
  command. Catches every client library uniformly.
- **Browser side** — `page.route()` with a catch-all `route.abort()` for non-loopback
  origins (PostHog, fonts, anything a future change adds).

Both fail closed. An unstubbed external origin fails the test rather than silently
reaching the network, which is what the ticket asked for — just achieved where the
calls actually happen.

**Safety bonus:** the deny-by-default server layer makes the E2E Next process
*structurally unable to reach `*.supabase.co`*, the same guarantee CAR-178's
loopback check gives the integration tier. This matters because
`careervine/.env.local` points at **production** Supabase, and Next loads it
automatically. Belt and braces: the webServer block also passes every Supabase var
explicitly (process env wins over `.env.local`), and the preload refuses to arm if
`NEXT_PUBLIC_SUPABASE_URL` is not loopback.

**2. Fixtures cannot be sourced from `fake-gmail.ts` as written.**
The ticket says to source response bodies from
`src/__tests__/helpers/fake-gmail.ts` / `fake-calendar.ts`. Those are **client-object
doubles** — they fake the `@googleapis/gmail` *client's* `messages.list` / `.get`
methods, not HTTP wire bodies. They are not reusable as fulfil bodies.

Instead: one shared module `careervine/e2e/fixtures/google-wire.mjs` holds the wire
payloads, imported by both the server preload (Node, runtime) and the browser-side
`page.route` helpers (TypeScript). One set of fixture data, in the place where both
layers can actually reach it. `fake-gmail.ts` stays the unit tier's client double;
the two live at genuinely different levels and pretending otherwise would be worse.
`.mjs` rather than `.ts` deliberately: the preload runs in the raw Next process
before any TS loader exists, and adding a loader hook into that process is risk we
do not need.

**3. Local Supabase has email confirmations OFF; production has them ON.**
`supabase/config.toml` → `[auth.email] enable_confirmations = false`. But
`auth-provider.tsx:118` branches specifically on confirmations-enabled behaviour
("Supabase obfuscates duplicate signups"), and the app ships a whole `/auth/confirm`
route (CAR-52). Locally, `signUp()` returns a session immediately and no verify step
happens at all — so flow 1 as specified would test a path that does not exist in
production.

Fix: flip `enable_confirmations = true`, raise `[auth.rate_limit] email_sent` off its
default of 2/hour, and stop excluding `mailpit` from the documented `supabase start`.
Flow 1 then reads the real confirmation email out of Mailpit's API and follows the
real link. Local matches production, and CAR-191's password-reset flow becomes
testable for free.

Blast radius is small and checked: `createTenant` uses
`admin.createUser({ email_confirm: true })`, so the integration tier is unaffected;
neither the `integration` nor `types-drift` job signs up. Local dev signup now needs
the Mailpit UI on `:54324`, same as production needs a real inbox — documented.

*Fallback if Mailpit proves flaky:* `generateLink({ type: 'signup' })` gives the same
`token_hash` deterministically with no mail service. Already proved working.

**4. CAR-183 is not merged, so the ticket's verification recipe cannot run as written.**
`git log --all --grep CAR-183` is empty; the bug is live in
`contact-follow-up-status.tsx:35-48` (`res.ok` never inspected, so a 500 still flips
the card to "Cancelled"). Reverting a fix that does not exist is not possible.

The equivalent — and stronger — proof is in §Flow 3 below: flow 3 gets a **second
test that pins the live bug** via a forced-500 `page.route`, annotated `test.fail()`.
It is red-by-design today, keeps CI green, and Playwright reports "expected to fail
but passed" the moment CAR-183 lands, forcing the annotation's removal. Plus a
deliberate mutation check (break the DELETE route, watch flow 3 go red) to prove the
reload assertion has teeth.

---

## Scope

### 1. Harness

- `@playwright/test` + `msw` as devDependencies. `careervine/playwright.config.ts`.
- `webServer`: `next build && next start -p 3100`, `reuseExistingServer: !process.env.CI`.
  Env passed explicitly — local Supabase values from `supabase status -o env`, plus
  the same placeholder set the CI `web` job's build already uses. `NEXT_PUBLIC_*` are
  inlined at build time, so the build must carry them.
- Projects: `setup` (`testMatch: /.*\.setup\.ts/`) → `chromium`
  (`dependencies: ['setup']`, `storageState`).
- `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`,
  `video: 'retain-on-failure'`, `retries: process.env.CI ? 2 : 0`.
- Shared stack resolution: a small helper that runs `supabase status -o env` and
  **refuses any non-loopback URL**, mirroring `src/__integration__/global-setup.ts`.

### 2. Auth via storageState

Setup project: `createTenant()` (reused from the integration harness) → seed → mint
the session by `admin.generateLink({type:'magiclink'})` then
`page.goto('/auth/confirm?token_hash=…&type=magiclink&next=/')` → `context.storageState()`.

This is better than signing in through the form: no coupling to the login UI, and no
coupling to `@supabase/ssr`'s cookie encoding, because the app's own route mints the
cookie. It also sidesteps a real harness gap — `createTenant` generates a password but
does **not** return it, so a browser could not sign in as that tenant anyway.

Flow 1 runs with `test.use({ storageState: { cookies: [], origins: [] } })`.

### 3. Third parties

As per Deviation 1. Server-side stub table starts with:
`gmail.googleapis.com/gmail/v1/users/*/messages/send`, `oauth2.googleapis.com/token`,
`www.googleapis.com`, `api.openai.com`, `api.resend.com`, `api.apify.com`. Everything
else external → 599 + a `[e2e-stubs] DENIED` line.

### 4. Three flows

**Flow 1 — sign up, verify, onboard.** No storageState. Landing → `Get started` →
`AuthForm` signup (first/last/email/password) → `Create account` → "Check your email"
→ read the confirmation link from Mailpit → follow it → `/` → the `OnboardingFlow`
modal ("Start with a network, not an empty page") → `Skip for now, I'll explore on my
own` → assert `SetupBanner` in its both-missing state: heading `Complete your setup`,
CTA link `Connect Gmail & Calendar`.

**Flow 2 — compose and send.** Seed a `gmail_connections` row (`send_scope_granted:
true`, `token_expires_at` > 5 min out so the refresh path stays quiet) plus a contact
with a primary email. `/inbox` → `Compose` → type into the To field → pick the
suggestion from the contact search dropdown → subject → body (TipTap is
**contenteditable**, so `pressSequentially`, not `fill`) → `Send` → assert the modal's
"Email sent" state → assert the thread appears in the Sent tab → assert the interaction
appears on the contact's timeline.

**Flow 3 — schedule and cancel a follow-up.** The sidebar card
(`ContactFollowUpStatus`) reads `GET /api/email-follow-ups?contactId=`, which filters
`.eq("contact_id", …)` — so the sequence must carry a `contact_id`, which only the
composer's `FollowUpPlanSection` path (`POST /api/email-follow-ups`) sets. So:
compose from the contact → `Add follow-ups` → send → sidebar card shows
"0 of 1 sent" → `Cancel` → **reload** → still "Cancelled".

The reload is the whole point: it is the assertion no current tier can make.

Plus the `test.fail()` bug-pin described in Deviation 4.

### 5. Selectors

`getByRole` wherever an accessible name already exists (all auth buttons, onboarding
buttons, the setup banner, most compose controls). `data-testid` only where role+name
is genuinely ambiguous or unstable — roughly:

- password input (`input[type=password]` has no ARIA role, and the type flips to
  `text` when revealed, changing its role mid-test)
- compose modal root, To input, suggestion option, subject input, TipTap editor host,
  Send button (`Send` also matches `Schedule send`)
- follow-up sidebar card, its per-sequence row, its progress/cancelled text, its
  `Cancel` button
- the toast body (so "an error toast fired" is distinguishable from "nothing happened"
  — the exact CAR-183 discriminator)

Scoped strictly to these three flows. No codebase-wide sweep.

### 6. Assertions

Web-first only. No `waitForTimeout`, no `sleep`. Waiting on Mailpit uses
`expect.poll`, not a sleep.

### 7. CI

New `e2e` job modelled on `integration`: same pinned `supabase/setup-cli` (2.109.1),
same exclusion list **minus `mailpit`**, `npx playwright install --with-deps chromium`,
upload `playwright-report/` and `test-results/` on failure.

### 8. Docs

`## i. End-to-end tests` in `careervine/CONVENTIONS.md`, pointer-index style. Note that
`conventions-doc.test.ts` asserts every cited path exists.

---

## Files

**New:** `careervine/playwright.config.ts`, `careervine/e2e/**`
(`fixtures/google-wire.mjs`, `server-stubs/register.mjs`, `helpers/*`, `*.setup.ts`,
`*.spec.ts`), `careervine/playwright/.auth/` (gitignored).

**Edited:** `careervine/package.json`, `careervine/.gitignore`,
`.github/workflows/ci.yml`, `careervine/CONVENTIONS.md`, `supabase/config.toml`,
plus `data-testid` on ~6 components.

---

## Parallelism with CAR-188

Overlap is the `data-testid` additions vs CAR-188's handler rewrites — textual, not
semantic. Whichever opens its PR second merges `main` in first. The `ci.yml` edit adds
a new top-level job, so it does not collide with CAR-186's change inside the `web` job.

Note: CAR-188 migrates these exact `fetch` sites to `apiFetch`/`withToastOnError`,
which is also CAR-183's fix. If CAR-188 lands first, the `test.fail()` annotation on
flow 3's bug-pin must come off in the merge.

---

## Verify

1. `npx playwright test` locally after `supabase start` (with Mailpit).
2. Break `DELETE /api/email-follow-ups/[id]` to return 500 and confirm flow 3's
   reload assertion goes red, then restore. Proves the assertion has teeth.
3. Confirm the bug-pin test reports `expected to fail` today.
4. `npm run test`, `npx tsc --noEmit`, `npx eslint . --max-warnings 0`,
   `npm run check:conventions` all green — `e2e/**` is inside the tsconfig `include`
   globs and will be typechecked and linted.
