# CareerVine conventions

This is a pointer index, not a map of the codebase. Each section states its rules in a few
lines and then names the code that is authoritative for them. When the two disagree, **the
code wins and this file is the bug**.

It deliberately does not describe directory layout, page inventories, or query catalogues.
Those drift within days, and the previous attempt at one (ARCHITECTURE.md) ended up with more
false claims than true ones.

**Read the cited header, not this file.** Every rule below has a reason, a failure it was
written to stop, and edge cases this file does not repeat. All of that lives in the header
named beside it. A rule you are about to work against is a rule whose header you should open
first.

Cited paths are relative to the repo root, and pointers name a file plus a symbol or "header"
rather than a line number, because line numbers rot silently and that is the failure this file
was written to end. `careervine/src/__tests__/conventions-doc.test.ts` asserts every path named
here still exists, pins the counted claims, and holds this file to its own citation format, so
a rename turns it red instead of quietly stale.

Each section says whether its rules have a mechanical guard or rest on review. Seven of the
nine do; c and e rest on review. Independently, CI runs typecheck, ESLint at zero warnings, the
Next build, the MCP typecheck, a Supabase types-drift check, an extension-bundle freshness
check, a unit-test coverage gate (§h), and `npm run check:conventions`.

---

## a. API routes

109 routes live under `careervine/src/app/api` and 92 of them go through `withApiHandler`,
which owns auth, the admin and capability gates, rate limiting, Zod validation (`paramsSchema`,
then `schema`, then `querySchema`), and error mapping, in that order. Gates and the limiter run
before the body is parsed. The 17 routes that skip the wrapper are the named allowlist in
section g.

Wrapper errors are `{ error }`, plus `code` on an `ApiError`, `capability` on a capability 403,
and `resetAt` on a 429. Hand-rolled routes are not bound by that shape.

Never interpolate a raw database or driver `error.message` into a client-visible message.
Throw a user-safe string and `console.error` the raw one.

Success responses serialize the handler's return value verbatim, typed through the `TResponse`
generic and recoverable as `InferApiResponse<typeof GET>`. Client code calls routes through
`apiFetch` / `apiSend` in `careervine/src/lib/api-client.ts`, never raw `fetch`; a route's true
wire type is `TResponse | ApiErrorBody`.

Shared request schemas live in `careervine/src/lib/api-schemas.ts` as `<domain><Action>Schema`.

- Authoritative: `careervine/src/lib/api-handler.ts` (header), `careervine/src/lib/api-client.ts` (header)
- Enforced: `careervine/src/__tests__/route-auth-inventory.test.ts` gates wrapper usage and
  inventories the three route handlers living elsewhere under `careervine/src/app`. The
  envelope and the curated-error rule are **not** enforced.

## b. Cron and queue

Scheduled work runs on **two** mechanisms, and which one a job belongs on is a real decision.

Nine QStash schedules exist, declared in exactly one place:
`careervine/scripts/qstash-schedules.mjs`. There are no `vercel.json` crons, no `pg_cron`, and
no scheduled GitHub Actions. `node scripts/qstash-schedules.mjs list` diffs declared against
live and exits 1 on drift.

The second is **systemd on the Oracle A1 box**, deployed from the repo-root `ops/` directory
rather than from this app, and it exists for what QStash cannot do. The send watcher
(`ops/send-watcher/`) is a long-running service that triggers due-send sweeps within ~15s,
which is the difference between a scheduled email landing at the minute the user picked and
landing up to an hour later. The two Gmail sync timers (`ops/gmail-sync/`, CAR-234) are there
because the schedule is expressed in the user's LOCAL time and systemd 249 on that box cannot
put a timezone in `OnCalendar`; the full sweep therefore ticks hourly and a wrapper picks the
three Mountain hours, so DST cannot slide it. Anything on A1 is invisible to
`qstash-schedules.mjs`, so a cadence question about scheduled work has to look in both places.

Every cron route nests `withQStashVerification` **outside** `withCronGuard`: credential first,
so an unauthenticated request 401s and the handler never runs, then error capture.
`api/queue/bundle-sync` verifies but is not a cron and does not guard.

Two credentials reach that wrapper, and which a route accepts is **per route, not global**: a
QStash signature, the default for all twelve verified consumers; and
`Authorization: Bearer $CRON_TRIGGER_SECRET`, accepted only by the four routes passing
`allowCronBearer`, all of them A1-driven and none able to produce a signature:
`api/cron/send-scheduled-emails` and `api/cron/send-follow-ups` (the send watcher), plus
`api/cron/sync-gmail-full` and `api/cron/sync-gmail-recent` (the sync timers). Both fail
closed when their secret is unset. The handler receives which credential admitted the caller
as its `source` argument.

**`allowCronBearer` defaults to false, and that default is the whole security boundary.**
CAR-215 checked the bearer at the shared chokepoint with no scoping, which silently opened
every route behind it, including two destructive purges and two paid Apify runs. The bearer
path also carries no body signature, so on an opted-in route the body is chosen by whoever
holds the secret: **a handler that trusts its body must not opt in.** Read the
`careervine/src/lib/qstash-verify.ts` header before adding a fifth route.

Changing a cadence means updating the copy that quotes it in the same change.

- Authoritative: `careervine/src/lib/qstash-verify.ts` and `careervine/src/lib/cron-guard.ts` (headers)
- Enforced: `careervine/src/__tests__/cron-schedules-registry.test.ts` pins every cron
  expression plus the cadence prose in `careervine/README.md` and
  `careervine/public/docs/index.html`; daily and weekly phrasing is not pinned.
  `careervine/src/__tests__/qstash-verify.test.ts` pins the wrapper with the option on and off,
  and `careervine/src/__tests__/route-auth-inventory.test.ts` pins which routes opt in, in both
  directions: adding the flag to a third route fails until its inventory entry says so.

## c. Capability gating

Gate on capability keys, never on a tier. The mapping lives in one function, `capabilitiesFor()`
in `careervine/src/lib/capabilities/map.ts`. Seven keys exist today.

Server-side, pass `requireCapability` to `withApiHandler`; it resolves through
`resolveCapabilities` and fails closed to 403 on a null user. Client-side, use
`useCapabilities()` (`careervine/src/hooks/use-capabilities.ts`) or `<Capable>`
(`careervine/src/components/capable.tsx`); the client never re-derives tier from raw flags.

One deliberate exception, documented at its call site in
`careervine/src/app/api/gmail/auth/route.ts`: OAuth scope selection reads raw connection flags,
because failing closed is right for gating and wrong for scope selection.

- Authoritative: `careervine/src/lib/capabilities/types.ts` (header), `careervine/src/lib/capabilities/resolve.ts`
- Not enforced. No lint rule or test distinguishes a capability check from a tier check.

## d. Data layer

Queries live in domain modules under `careervine/src/lib/data/`.
`careervine/src/lib/queries.ts` is a frozen compatibility barrel: add nothing to it.

The Supabase client resolves lazily through `db()`. `setDataClient()` may only receive a client
that preserves per-user authorization, because these modules lean on RLS for tenant isolation.

Reads carrying control flow (cursors, dedup probes, claim preconditions) use `must()` so a
failed query throws instead of reading as empty. A cosmetic read may tolerate an error only
with an explicit `// error-tolerated:` comment.

PostgREST caps a response at 1000 rows and truncates silently. Chunk and
paginate through `careervine/src/lib/data/postgrest.ts`, whose header says which
of the three helpers applies. `check:conventions` ratchets every multi-row read
it cannot prove bounded, so a new unpaginated one fails the build and a fixed
one must leave the baseline (CAR-223).

Paging is not free, and two further checks say so (CAR-229). A read in this
directory that pages a table to EXHAUSTION with nothing but `user_id` narrowing
it costs the whole account on every call; those that do it deliberately are
named in `EXHAUSTIVE_SWEEP_ALLOWLIST`, and a new one needs a line there with a
reason. Separately, every `.range()` window must carry an `.order()` — range
pagination over an unordered query duplicates and drops rows at page
boundaries — and that one is frozen at zero with no escape hatch.

School affinity has ONE authority per language: `careervine/src/lib/schools/affinity.ts` in
TypeScript, `is_byu_family_school()` / `is_alumni_only_prospect()` in SQL, held together by
`careervine/src/__integration__/school-affinity-parity.itest.ts`. Never read
`user_metadata.university` to gate data: it is user-writable; `public.users.university` is
canonical.

The four relationship rules live in `careervine/src/lib/rules/`. The three reading the contact
list filter internally via `isActiveContact`, so a fetch site that forgets a `network_status`
filter cannot widen their population; `deriveNeglectedContacts` consumes a `days_since_touch`
computed at the fetch site.

Contact writes canonicalize inside `careervine/src/lib/data/contacts.ts`, locations inside
`careervine/src/lib/data/locations.ts`. Under MCP the service-role client bypasses RLS, so
every query scopes to the operating user or sits behind an ownership assertion.

Five `calendar_events` columns are application-owned and unrecoverable from a re-sync. A
migration deleting or truncating that table must preserve them or carry a
`-- destructive-resync-audited:` annotation.

`is_excluded` on the five timeline-backing tables means "still stored, must not count toward
anything derived". Every read of those tables filters it or writes down why it does not, in an
`// exclusion-exempt: <reason>` comment on the chain. The bar for the hatch is that the read is
not producing a value the user sees: sync bookkeeping, real reply threading, abuse controls and
the record views the timeline restores from. Read the check's own header before adding one; it
explains why the guard exists at all, which is that the near-identical `is_simulated` is applied
at 6 of the roughly 22 reads that need it and nothing catches the rest.

- Authoritative: `careervine/src/lib/queries.ts` (header), `careervine/src/lib/data/client.ts`
  (header, and the `must()` docblock), `careervine/src/mcp/lib/db.ts` (header)
- Enforced: `careervine/src/mcp/__tests__/db-scoping.test.ts`,
  `careervine/src/__tests__/contact-write-chokepoint.test.ts`, the `no-restricted-imports`
  fences in `careervine/eslint.config.mjs`, and the data-layer checks in
  `careervine/scripts/check-conventions.mjs`. Escape hatches `// cas-checked:` and
  `// error-tolerated:` both demand a written reason. The app-owned-column rule is enforced by
  `careervine/src/__tests__/migration-destructive-guard.test.ts` (authoritative header there).

## e. Sending email

Two senders, and the direction decides which. `sendAppEmail` is CareerVine writing to the user
over Resend. `sendTrackedEmail` is the user's own Gmail writing to their contacts.

Everything outbound to a contact goes through `sendTrackedEmail`, which applies the daily cap,
refuses known-bounced addresses, and logs the interaction. Crons are not exempt: they catch
`SendPolicyError` to defer rather than bypass.

Threading a reply is separate. In-Reply-To / References must carry an RFC 822 `Message-ID`,
never the Gmail API id stored as `original_gmail_message_id`. Follow-up senders resolve real ids
through `resolveFollowUpThreadHeaders`, which omits the headers rather than guessing.

`detectBounces` in `careervine/src/lib/gmail.ts` owns the consequences of a delivery failure;
`careervine/src/lib/bounce-parse.ts` owns whether a given NDR proves an address is dead. Read
that second header before touching detection: the parse is deliberately biased toward
extracting nothing when evidence is ambiguous. Detection needs a mailbox read scope and runs
only for premium connections; everything downstream of it is ungated on purpose.

A reply retires a sequence, and `cancelFollowUpsForRepliedThreads`
(`careervine/src/lib/follow-up-helpers.ts`) is the only thing allowed to do it. Three callers
learn about the reply differently (a Gmail sync ingesting an inbound row, the send cron's own
`threads.get`, the free tier's manual mark) and all share the one cascade. Read its header
before adding a fourth: the edge cases it encodes are the ones a fresh copy drops.

- Authoritative: `careervine/src/lib/notify/email.ts`, `careervine/src/lib/email-send.ts`
  (headers), `careervine/src/lib/follow-up-threading.ts`,
  `careervine/src/lib/follow-up-helpers.ts` (header), and
  `careervine/src/lib/bounce-parse.ts` (header)
- Enforced: `careervine/src/__tests__/bounce-parse.test.ts`,
  `careervine/src/__tests__/detect-bounces.test.ts`, and
  `careervine/src/__tests__/cancel-followups-on-reply.test.ts`. The two-sender rule itself is
  not enforced: nothing stops a new caller reaching for the wrong one.

## f. Client state

Broadcast typed events through `careervine/src/lib/ui-events.ts` (`emitUiEvent` / `onUiEvent`),
never a raw `window` CustomEvent.

Identity-keyed async reads go through `useLatestRequest`
(`careervine/src/hooks/use-latest-request.ts`): claim a token with `begin()`, gate the state
update on `isLatest(token)`.

A list read that must survive back-navigation goes through `useCachedList`
(`careervine/src/hooks/use-cached-list.ts`) over the module store in
`careervine/src/lib/list-cache.ts`, which is where the reasoning lives: why the cache is
in-memory rather than localStorage, why nothing stale is ever served while a refetch runs, and
why a write REFRESHES the key rather than merely dropping it. Three rules that are easy to get
wrong and are stated there: hydration happens in the state initializer (a list populated one
render late is a list scroll restoration cannot use); a write that changes what a row displays
refreshes at the WRITE SITE, not over `ui-events.ts`, because the list is unmounted at that
moment and has no listener mounted; and the fetcher therefore lives beside the cache key rather
than in the page, shared with the page so the two cannot issue different queries.
`careervine/src/lib/companies-list-cache.ts` is the worked example. A test that renders a page
using it must call `resetListCache()` in `beforeEach`, or the cache leaks between cases and the
suite goes order-dependent.

Scroll restoration pairs with it: `careervine/src/hooks/use-scroll-restoration.ts` over
`careervine/src/lib/scroll-memory.ts`, which owns the `popstate` signal that separates a genuine
return from a fresh visit through the nav bar, and the anchor that survives a list reordering
underneath a remembered offset. A row a return trip should land on carries
`data-scroll-anchor`.

Client code never calls `fetch` directly, and neither does a browser-reached helper under
`careervine/src/lib`. "Browser-reached" is decided by import graph, not directory. Reads go
through `apiFetch`, status-only mutations through `apiSend`. An interactive handler wraps the
call in `withToastOnError` (`careervine/src/lib/with-toast-on-error.ts`) and gates its state
update on the `true` return, supplying its own user-facing copy rather than surfacing the
route's message.

Reversible writes are optimistic with rollback plus a toast; irreversible actions get a confirm
modal via `useConfirm()` in `careervine/src/components/ui/confirm-dialog.tsx`, never
`window.confirm`.

A failed load renders a retryable error state, never the load-empty copy: an empty list is an
affirmative claim about the user's data. `LoadErrorState` and `LoadErrorBanner` live in
`careervine/src/components/ui/load-error-state.tsx`. Re-reading after a **failed** write keeps
what is on screen and stays silent, since the toast already fired; re-reading after a
**successful** write, on mount, or on explicit retry must surface the failure. Compare
`careervine/src/components/contacts/contact-follow-up-status.tsx` (carries a `mode` parameter
for exactly this) against `careervine/src/components/settings/templates-section.tsx` (does not,
because no path in it re-reads after a failed write).

A genuinely tolerated error carries an `// error-tolerated:` comment. The bar is that the user
did not ask for the request and nothing they see depends on it. A bare `.catch(() => {})` is a
silent failure, not tolerance.

Double submits are blocked with a synchronous `useRef(false)` (`submittingRef` in
`careervine/src/components/compose-email-modal.tsx`, `savingRef` in
`careervine/src/components/contacts/contact-edit-modal.tsx`), checked and set before the first
await and reset in `finally`, separate from the boolean UI state.

Every dialog goes through `careervine/src/components/ui/modal.tsx`, which splits into
`DialogSurface` (what makes something a dialog) and `Modal` (the M3 chrome over it, and the
default). A modal child that portals uses `useModalPortalContainer()`; a footer Cancel or header
X reaches dismissal through `ModalCancelButton` / `ModalCloseButton`, not the caller's own
`onClose`. Worked examples: `careervine/src/hooks/use-portal-dropdown.ts` and
`careervine/src/components/ui/select.tsx` for the portal target,
`careervine/src/components/contacts/contact-timeline-tab.tsx` for the buttons.

**Any** child that opens and closes owns Escape while it is open, and hands focus back if its
panel holds focusable controls. Which mechanism depends on where the panel lives: portalled out
of the subtree uses a capture-phase document listener (`use-portal-dropdown.ts`,
`select.tsx`); a plain DOM child of the wrapper uses a wrapper `onKeyDown`
(`careervine/src/hooks/use-dropdown-escape.ts`, used by
`careervine/src/components/ui/contact-picker.tsx`,
`careervine/src/components/ui/month-year-picker.tsx`,
`careervine/src/components/ui/school-autocomplete.tsx` and
`careervine/src/components/ui/degree-autocomplete.tsx`). Read both headers before adding a
third caller; the ownership check differs by widget and copying the wrong one reintroduces the
bug.

Every dialog surface registers as a dismissal layer via `useDialogLayer()`, which `DialogSurface`
does for everything built on it. The one exception is a dialog rendered inside another as its
confirmation step, which must not register.

`<Select>` and `<MonthYearPicker>` take an `ariaLabel` naming the field, because their trigger
is a `<button>` no visible `<label>` can be associated with.

A subtree that can independently fail gets wrapped in
`careervine/src/components/ui/section-boundary.tsx`. Do not hand-roll a class `ErrorBoundary`.
Route-level boundaries are `careervine/src/app/error.tsx`,
`careervine/src/app/global-error.tsx` and `careervine/src/app/admin/error.tsx`; all report
through `careervine/src/lib/report-error.ts`. Boundaries catch render throws only.

- Authoritative: `careervine/src/lib/ui-events.ts`, `careervine/src/hooks/use-latest-request.ts`,
  `careervine/src/components/ui/modal.tsx`, `careervine/src/components/ui/confirm-dialog.tsx`,
  `careervine/src/lib/api-client.ts`, `careervine/src/hooks/use-portal-dropdown.ts`,
  `careervine/src/hooks/use-dropdown-escape.ts`, and
  `careervine/src/components/ui/section-boundary.tsx` (headers)
- Enforced (adoption, CI): `careervine/scripts/check-ui-events.mjs`,
  `careervine/src/__tests__/select-aria-label.test.ts`, and
  `careervine/src/__tests__/dialog-adoption.test.ts` — the SOLE enforcer of the dialog rule,
  whose one escape-hatch spelling is `non-dialog-overlay:`.
  `careervine/scripts/check-conventions.mjs` adds four more: no raw `fetch(` and no native
  confirm (both frozen at zero), plus double-submit-ref and `useLatestRequest` ratchets over a
  named baseline. **Read `careervine/scripts/lib/ratchet.mjs` before quoting either baseline
  figure** — it is a measurement of the detector, not of the codebase, and the header explains
  why it is deliberately an over-count and how tuning it the obvious way breaks it.
- Enforced (behavior): `careervine/src/__tests__/modal.test.tsx`,
  `careervine/src/__tests__/dialog-layer.test.tsx`, `careervine/src/__tests__/picker-escape.test.tsx`,
  `careervine/src/__tests__/error-boundaries.test.tsx`,
  `careervine/src/__tests__/use-latest-request.test.tsx`,
  `careervine/src/__tests__/compose-modal-send-guards.test.tsx`,
  `careervine/src/__tests__/double-submit-guards.test.tsx` and
  `careervine/src/__tests__/outreach-detail-race.test.tsx`.
- Enforced (mutation contract): `careervine/src/__tests__/api-client.test.ts`,
  `careervine/src/__tests__/confirm-dialog.test.tsx`, and the per-component tests named in
  `careervine/src/__tests__/client-mutation-contract.test.tsx`.

## g. Auth exceptions, secrets, machine tokens, package edges

The 17 routes that deliberately skip `withApiHandler` are named, with the mechanism each uses,
in the `HAND_ROLLED` map in `careervine/src/__tests__/route-auth-inventory.test.ts`. Six
mechanisms are in play: qstash-signature, qstash-signature+cron-bearer, bundle-admin-token,
webhook-secret, hmac-token, and oauth-jwks. Adding an unwrapped route without listing it fails
CI, and so does a stale entry.

A module reading a secret from `process.env` carries `import "server-only"`, so a client
component importing it fails `next build` instead of shipping the credential read to the
browser. The fenced set, the two written exemptions, and the new-module catch live in
`careervine/src/__tests__/server-only-fence.test.ts`. Two non-Next runtimes need help:
`careervine/vitest.config.ts` aliases `server-only` to an empty module, and the MCP start script
passes `--conditions=react-server`.

`BUNDLE_ADMIN_TOKEN` guards the two admin machine routes through `isAuthorizedAdminToken`
(`careervine/src/lib/admin-auth.ts`), which digests both sides before a constant-time compare
and returns false when the secret is unset. There is no dual-token overlap window: rotating it
means setting the new value and redeploying.

`CRON_TRIGGER_SECRET` is the other machine token, held by the send watcher on the Oracle A1 box
and deployed from the repo-root `ops/send-watcher/` directory rather than from this app. It has
its own hash-then-constant-time compare in `careervine/src/lib/qstash-verify.ts` (not the admin
token's helper) and is likewise refused when unset. Unlike the admin token it is scoped per
route rather than per call site, through `allowCronBearer` (section b): reach for that option
only when a caller genuinely cannot sign, and expect to justify it in the route inventory.

Three package edges are wired through tsconfig `paths`, as seven mappings. A module imported
across an edge must stay free of React and chrome APIs, because crossing the edge drags them
into the build.

- Authoritative: the `HAND_ROLLED` map in `careervine/src/__tests__/route-auth-inventory.test.ts`,
  `isAuthorizedAdminToken` in `careervine/src/lib/admin-auth.ts`, and the `paths` blocks in
  `careervine/tsconfig.json` and `careervine-mcp/tsconfig.json`
- Enforced: the route allowlist is a CI test. The tsconfig edges are enforced by the MCP
  typecheck job.

## h. Tests

Reuse the shared harness helpers instead of re-rolling a fake:
`careervine/src/__tests__/helpers/fake-gmail.ts`,
`careervine/src/__tests__/helpers/fake-calendar.ts`,
`careervine/src/__tests__/helpers/fake-fetch.ts`, and
`careervine/src/mcp/__tests__/helpers/recording-client.ts` for scoping assertions.

A `vi.mock` factory is not typechecked against the module it replaces. Mocks of the eight
most-mocked modules go through the shared factories in `careervine/src/__tests__/helpers/`;
`typedMock<typeof import("…")>()` in `careervine/src/__tests__/helpers/typed-mock.ts` gives a
one-off mock the same constraint. **Read that header before writing one** — where you call the
helper matters, and the natural placement is a hoisting bug.

A component test exercising an HTTP call uses `installFakeFetch`, which routes on
`"METHOD /url"` and answers with a real `Response`. Assert `unmatched` is empty.

The global environment is node; a DOM test opts in per file with `// @vitest-environment jsdom`.
jest-dom matchers are not wired, so assert with `getByText` / `queryByText`.

A second tier covers what mocks structurally cannot express: `*.itest.ts` files under
`careervine/src/__integration__/` run against the local Supabase stack via
`npm run test:integration`. It owns tenant isolation for every RLS table, the scheduled-send
money path, CHECK-constraint conformance, and the account-deletion cascade. Do not port mocked
tests into it.

Coverage is a gate rather than a report, measuring `careervine/src/lib`, `careervine/src/hooks`
and `careervine/src/mcp`. `careervine/src/components` and `careervine/src/app` are deliberately
unmeasured; the browser tier owns them.

- Authoritative: `careervine/vitest.config.ts`, `careervine/vitest.integration.config.ts`
  (header), the header of each helper, and `careervine/src/__integration__/helpers/stack.ts` (header)
- Enforced (mocks): a check in `careervine/scripts/check-conventions.mjs` (escape hatch
  `// typed-mock-exempt: <reason>`), pinned by
  `careervine/src/__tests__/check-conventions.test.ts`, with the type constraint behind it in
  `careervine/src/__tests__/typed-mock.type-test.ts`.
- Enforced (integration tier): the completeness guard in
  `careervine/src/__integration__/rls-tenant-isolation.itest.ts`
- Enforced (coverage): the thresholds in `careervine/vitest.config.ts`, run by the `web` job in
  `.github/workflows/ci.yml`. Harness reuse, environment opt-in and matcher choice are not
  mechanically enforced.

## i. End-to-end tests

A third tier: real Chromium against a real `next build && next start`, backed by the same local
Supabase stack the integration tier uses. It exists for the one thing neither other tier can
express — whether a change the UI *claims* to have made actually persisted. Fourteen flows live in
`careervine/e2e/*.spec.ts`. Thirteen are persistence-or-rendering flows; the other,
`request-budget.spec.ts`, is a per-route ceiling on how many data requests a page load may
make, which is the other thing only a real browser can count (CAR-229). Run it:

```
supabase start -x studio,imgproxy,edge-runtime,realtime,storage-api,vector,logflare,supavisor
cd careervine && npm run test:e2e
```

That exclusion list is the integration tier's **minus mailpit**: local auth runs with
confirmations on, so signup sends a real email the flow reads back, and without Mailpit signup
fails outright. `supabase/templates/` is the single source of truth for both the local stack and
production.

**One run at a time per local Supabase stack, enforced (CAR-273).** Every worktree shares one
stack, and `careervine/e2e/tenant.teardown.ts` deletes by PREFIX, so two concurrent runs delete
each other's tenants mid-flight. `careervine/e2e/helpers/stack-lock.ts` takes a lock in
`os.tmpdir()` keyed on the stack's DB URL and refuses a second run by name; a crashed holder's
lock is taken over on a dead pid, so nothing wedges permanently. The port is separately derived
per checkout in `careervine/e2e/helpers/ports.ts`, so two worktrees do not collide on 3100 — but
that only fixes the port, which is why the lock exists.

The arming receipt is verified **over HTTP**, not just on disk. `global-setup` fetches
`/__e2e__/arming`, which `register.mjs` answers from the serving process's own memory with this
run's nonce. A file can only prove the stub layer armed in SOME process: CAR-273 was a second
worktree's server arming, writing the receipt, then failing to bind, after which the suite ran
against the first worktree's build with the receipt looking healthy.

Third parties are intercepted in two places and the split is not optional, because the calls
that matter are made server-side where `page.route()` cannot see them.
`careervine/e2e/server-stubs/register.mjs` runs MSW inside the server; the `networkGuard`
fixture in `careervine/e2e/fixtures/test.ts` covers browser traffic. Both deny by default. A new
external origin needs a handler in the server stub layer; `networkGuard.allow()` is browser-side
only. Read the register header for why denials are read back from a file rather than logged.

Stub responses are fixed for the whole run. Where a flow needs a particular value it seeds the
database to match the stub, not the reverse. Wire-shaped fixtures live in
`careervine/e2e/fixtures/google-wire.mjs` and `careervine/e2e/fixtures/third-party-wire.mjs`.
`careervine/src/__tests__/helpers/fake-gmail.ts` is *not* reusable here: it doubles the client
object, not the HTTP body.

The server's environment is a closed set, not the developer's shell:
`careervine/e2e/helpers/env-allowlist.ts` closes over all three sources. A var a *dependency*
reads must be pinned to a real value rather than blanked.

Authentication never drives the login form. `careervine/e2e/auth.setup.ts` provisions a tenant
and mints the session through the app's real `/auth/confirm` route. One shared tenant,
single-worker, so flows write to one database in file order. Six specs mint their own identity
instead. A spec that mutates shared state restores it in `afterEach`, not `finally`; where the
damage is wider than the restore, own a tenant instead. Read
`careervine/e2e/helpers/tenant.ts` before adding a spec.

Selectors prefer `getByRole` / `getByLabel`; `data-testid` only where role plus name is genuinely
unreachable. Assertions are web-first — no `waitForTimeout`, no sleep. **Asserting that something
did NOT happen needs the causal event first**, or the assertion passes before the thing it guards
against could have occurred; `careervine/e2e/fixtures/test.ts` carries the sequencing recipe.

- Authoritative: `careervine/playwright.config.ts` (header),
  `careervine/e2e/server-stubs/register.mjs` (header), `careervine/e2e/fixtures/test.ts` (header),
  `careervine/e2e/helpers/env-allowlist.ts` (header), `careervine/e2e/helpers/tenant.ts` (header),
  `careervine/e2e/helpers/ports.ts`, and `careervine/e2e/helpers/stack-env.ts` (header)
- Counted: Fourteen flows in `careervine/e2e/*.spec.ts`, pinned by
  `careervine/src/__tests__/conventions-doc.test.ts` so a fifteenth cannot silently falsify this
  section.
- Enforced: CI runs it as the separate `e2e` job with `failOnFlakyTests`. The deny-by-default
  stub layers are self-enforcing. `careervine/src/__tests__/e2e-env-allowlist.test.ts` fails when
  the app reads a var the allowlist does not pin. `careervine/e2e/global-setup.ts` and
  `careervine/e2e/global-teardown.ts` catch denials outside the per-test windows. Nothing enforces
  the no-arbitrary-wait rule.
