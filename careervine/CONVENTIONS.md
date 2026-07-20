# CareerVine conventions

This is a pointer index, not a map of the codebase. Each section states a rule in
a few lines and then names the code that is authoritative for it. When the two
disagree, **the code wins and this file is the bug**.

It deliberately does not describe directory layout, page inventories, or query
catalogues. Those drift within days and the previous attempt at one (ARCHITECTURE.md)
ended up with more false claims than true ones. Read the cited header, not a
summary of it.

Cited paths are relative to the repo root, and pointers name a file plus a symbol
or "header" rather than a line number, because line numbers rot silently and that
is the failure this file was written to end. A test
(`careervine/src/__tests__/conventions-doc.test.ts`) asserts every path named here
still exists, so a rename turns this file red instead of quietly stale.

Each section says whether its rules have a mechanical guard or rest on review.
Five do. Independently of them, CI runs typecheck, ESLint at zero warnings, the
Next build, the MCP typecheck, a Supabase types-drift check, and an
extension-bundle freshness check.

---

## a. API routes

105 routes live under `careervine/src/app/api` and 91 of them go through
`withApiHandler`, which owns auth, the admin and capability gates, rate limiting,
Zod validation (`paramsSchema`, then `schema`, then `querySchema`), and error
mapping, in that order. The gates and the limiter deliberately run *before* the
body is parsed, so a rejected request stays cheap. The 14 routes that skip the
wrapper are the named allowlist in section g.

Errors from the wrapper are always `{ error }`, plus `code` when an `ApiError`
carries one, `capability` on a capability 403, and `resetAt` on a 429. The
hand-rolled routes are not bound by that shape: `apify/run-callback` answers 503
with `{ success: false }`, and the hand-rolled 429s carry no `resetAt`.

Success responses are the handler's return value serialized verbatim, unless the
handler returns a `NextResponse` itself (used for OAuth redirects), which passes
through untouched. The intended shape is `{ success: true, ... }`, though only
about half the non-admin routes currently say so; routes under `admin/`
consistently use their own `ok: true`.

Curated errors: never interpolate a raw database or driver `error.message` into a
client-visible message, because those leak schema detail. Throw a user-safe string
and `console.error` the raw one.

Shared request schemas live in `careervine/src/lib/api-schemas.ts` as
`<domain><Action>Schema`; a schema used by exactly one route may stay in that
route's file.

- Authoritative: `careervine/src/lib/api-handler.ts` (header)
- Enforced: `careervine/src/__tests__/route-auth-inventory.test.ts` gates wrapper
  usage under `careervine/src/app/api`, and separately inventories the three route
  handlers that live elsewhere under `careervine/src/app` (the email-confirmation
  handler, which is unauthenticated because it is what mints the session, and the
  two public OAuth metadata documents), each with its named mechanism and its
  expected HTTP methods pinned. The envelope and the curated-error rule are
  **not** enforced.

## b. Cron and queue

Eight QStash schedules exist and are declared in exactly one place:
`careervine/scripts/qstash-schedules.mjs`. There are no `vercel.json` crons, no
`pg_cron`, and no scheduled GitHub Actions. `node scripts/qstash-schedules.mjs list`
diffs declared against live and exits 1 on drift; `sync` reconciles but never
deletes an undeclared schedule.

Every cron route nests `withQStashVerification` **outside** `withCronGuard`:
signature first, so an unsigned request 401s and the handler never runs, then
error capture. Verification fails closed when the signing keys are unset rather
than constructing a permissive receiver. `api/queue/bundle-sync` verifies but is
not a cron and does not guard.

When you change a cadence here, update the copy that quotes it in the same
change. `careervine/README.md` and `careervine/public/docs/index.html` both state
cadences, and a test pins them to this registry.

- Authoritative: `careervine/src/lib/qstash-verify.ts` and
  `careervine/src/lib/cron-guard.ts` (headers)
- Enforced: `careervine/src/__tests__/cron-schedules-registry.test.ts` pins every
  cron expression, the follow-up and scheduled-email cadence prose in both the
  README and the docs page (subject-anchored, so swapping the two lines fails),
  the docs page's follow-ups feature-card tag, and the cadence stated in the two
  interval cron routes' header comments. Daily and weekly copy phrasing is not
  pinned.

## c. Capability gating

Call sites gate on capability keys, never on a tier. The tier to capability
mapping lives in one function, `capabilitiesFor()` in
`careervine/src/lib/capabilities/map.ts`. Seven keys exist today.

Server-side, pass `requireCapability` to `withApiHandler`; it resolves through
`resolveCapabilities` and fails closed to 403 on a null user. Client-side, use
`useCapabilities()` or `<Capable>`; the client never re-derives tier from raw
flags.

One deliberate exception: choosing which OAuth scopes to request reads the raw
connection flags directly, because failing closed is right for gating and wrong
for scope selection. It is documented at the call site in
`careervine/src/app/api/gmail/auth/route.ts`.

- Authoritative: `careervine/src/lib/capabilities/types.ts` (header)
- Not enforced. No lint rule or test distinguishes a capability check from a tier
  check, and a few admin surfaces do read raw flags.

## d. Data layer

Queries live in domain modules under `careervine/src/lib/data/`.
`careervine/src/lib/queries.ts` is a frozen compatibility barrel of re-exports:
add nothing to it, and prefer importing from the domain module directly.

The Supabase client is resolved lazily through `db()`. `setDataClient()` may only
receive a client that preserves per-user authorization, because most of these
modules filter by row id and lean on RLS for tenant isolation.

Reads that carry control flow (cursors, dedup probes, claim preconditions) use
`must()` so a failed query throws instead of silently reading as empty. A
purely cosmetic read may tolerate an error, but only with an explicit
`// error-tolerated:` comment saying why.

PostgREST caps a response at 1000 rows. Chunk and paginate through
`careervine/src/lib/data/postgrest.ts` rather than hand-rolling either.

The four relationship rules (due follow-ups, on-track, neglected, streak) are
pure functions in `careervine/src/lib/rules/`. The three that read the contact
list apply active-only filtering internally via `isActiveContact`, so a fetch site
that forgets a `network_status` filter cannot widen their population; the streak
rule reads activity tables instead and has no contact population to narrow. Three
of the four take the clock as `nowIso`; `deriveNeglectedContacts` instead consumes
a `days_since_touch` already computed at the fetch site.

Contact writes canonicalize inside `careervine/src/lib/data/contacts.ts`, and
location rows inside `careervine/src/lib/data/locations.ts`, so no caller can
skip normalization.

Under MCP the service-role client bypasses RLS, so every query either scopes to
the operating user or sits behind an ownership assertion.

- Authoritative: `careervine/src/lib/queries.ts` (header),
  `careervine/src/lib/data/client.ts` (header, and the `must()` docblock),
  `careervine/src/mcp/lib/db.ts` (header)
- Enforced: `careervine/src/mcp/__tests__/db-scoping.test.ts` (a new export
  without a classification entry fails), `careervine/src/__tests__/contact-write-chokepoint.test.ts`,
  and the `no-restricted-imports` fences in `careervine/eslint.config.mjs`.

## e. Sending email

Two senders, and the direction decides which. `sendAppEmail` is CareerVine
writing to the user over Resend from the careervine.app identity. `sendTrackedEmail`
is the user's own Gmail writing to their contacts.

Everything outbound to a contact goes through `sendTrackedEmail`, which applies
the daily send cap, refuses known-bounced addresses, warns on pattern-guessed
ones, and logs the interaction. Crons are not exempt: they call it like the
interactive paths and catch `SendPolicyError` to defer rather than bypass.

- Authoritative: `careervine/src/lib/notify/email.ts` and
  `careervine/src/lib/email-send.ts` (headers)
- Not enforced. Nothing stops a new caller reaching for the wrong one.

## f. Client state

Views stay coherent by broadcasting typed events through
`careervine/src/lib/ui-events.ts` (`emitUiEvent` / `onUiEvent`), never a raw
`window` CustomEvent, so a misspelled event name is a compile error.

Identity-keyed async reads go through `useLatestRequest`: claim a token with
`begin()` when the request starts, gate the state update on `isLatest(token)`, so
a slow earlier response cannot overwrite a newer one.

Reversible writes are optimistic with rollback plus a toast on failure;
irreversible actions get a confirm modal instead. There is no helper, it is
written per site.

Double submits are blocked with a synchronous `useRef(false)` (`submittingRef` or
`savingRef`), checked and set before the first await and reset in `finally`. It is
separate from the boolean UI state because a state update is async and would not
block a fast second click.

New modals use `careervine/src/components/ui/modal.tsx`, which provides the scrim,
escape handling, body scroll lock, and the unsaved-changes guard. It does not
provide a focus trap. Adoption is currently even with hand-rolled dialogs, so this
rule is forward-looking rather than descriptive.

- Authoritative: `careervine/src/lib/ui-events.ts` and
  `careervine/src/hooks/use-latest-request.ts` (headers)
- Enforced: `careervine/scripts/check-ui-events.mjs` runs in CI and bans the raw
  event-name prefix outside the module. The other four rules are not enforced.

## g. Auth exceptions, machine tokens, package edges

The 14 routes that deliberately skip `withApiHandler` are named, with the
mechanism each uses, in the `HAND_ROLLED` map in
`careervine/src/__tests__/route-auth-inventory.test.ts`. Five mechanisms are in
play: qstash-signature, bundle-admin-token, webhook-secret, hmac-token, and
oauth-jwks. Adding an unwrapped route under `careervine/src/app/api` without
listing it fails CI, and so does leaving a stale entry behind.

`BUNDLE_ADMIN_TOKEN` guards the two admin machine routes through
`isAuthorizedAdminToken`, which SHA-256 digests both sides before a constant-time
compare and returns false when the secret is unset. Both call sites read
`process.env` per request, so rotating it means setting the new value in Vercel
and redeploying; there is no dual-token overlap window, so the old token stops
working the moment the new deployment goes live.

Three package edges are wired through tsconfig `paths`, as seven mappings:
careervine to chrome-extension (`@ext`, `@panel`), careervine-mcp to careervine
(`@/*` plus two that resolve the MCP SDK out of careervine's `node_modules`), and
careervine-mcp to chrome-extension (`@ext`, `@panel`). Next reads that `paths`
block natively, so these aliases resolve in the Next build as well as in typecheck
and vitest. That is exactly why a module imported across an edge must stay free of
React and chrome APIs: crossing the edge drags them into the build.

- Authoritative: the `HAND_ROLLED` map in
  `careervine/src/__tests__/route-auth-inventory.test.ts`,
  `isAuthorizedAdminToken` in `careervine/src/lib/admin-auth.ts`, and the `paths`
  blocks in `careervine/tsconfig.json` and `careervine-mcp/tsconfig.json`
- Enforced: the route allowlist is a CI test. The tsconfig edges are enforced by
  the MCP typecheck job, which installs careervine's dependencies first precisely
  because of the two SDK mappings.

## h. Tests

New tests reuse the shared harness helpers instead of re-rolling a fake:
`careervine/src/__tests__/helpers/fake-gmail.ts`,
`careervine/src/__tests__/helpers/fake-calendar.ts`, and
`careervine/src/mcp/__tests__/helpers/recording-client.ts` for scoping assertions.

The global environment is node. A DOM test opts in per file with a
`// @vitest-environment jsdom` docblock. jest-dom matchers are not wired, so
assert with `getByText` / `queryByText` rather than `toBeInTheDocument`.

- Authoritative: `careervine/vitest.config.ts` and the header of each helper
- Not mechanically enforced; the only backstop is the suite itself passing.
