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
Seven of the nine do; c and e rest on review. Independently of them, CI runs
typecheck, ESLint at zero warnings, the Next build, the MCP typecheck, a Supabase
types-drift check, an extension-bundle freshness check, a unit-test coverage gate
(§h), and the convention-guard script (`npm run check:conventions`).

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

Success shapes are typed (CAR-158): `withApiHandler` carries a `TResponse`
generic inferred from the handler's return, recoverable by consumers as
`InferApiResponse<typeof GET>`. Client code calls routes through `apiFetch` /
`apiSend` in `careervine/src/lib/api-client.ts`, which discriminate on status and
throw `ApiRequestError` carrying the curated message, so an error body can never
be mistaken for the success shape. A route's true wire type is
`TResponse | ApiErrorBody`; typing only the happy path would make client code
more wrong, not less.

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

School affinity — whether a user's school changes what they see — has ONE
authority per language: `careervine/src/lib/schools/affinity.ts` in TypeScript
and `is_byu_family_school()` / `is_alumni_only_prospect()` in SQL. They are held
together by `careervine/src/__integration__/school-affinity-parity.itest.ts`,
which runs one shared fixture through both against real Postgres. This rule
exists because the test it replaced did not: the same predicate was previously
copy-pasted into two TS helpers and three inline SQL predicates, each commented
as mirroring one of the others, with nothing anywhere to notice when one
changed. Never read `user_metadata.university` to gate data — it is
user-writable; `public.users.university` is canonical.

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

`calendar_events` caches Google Calendar, but four of its columns are
application-owned and unrecoverable from a re-sync
(`source_gmail_thread_id`, `source_gmail_message_id`, `meeting_id`,
`zoom_link`). A migration that deletes or truncates rows from that table must
preserve them or carry a `-- destructive-resync-audited:` annotation; the
CAR-152 repair migration deleted a 67-day window without doing either and
permanently erased every email-to-meeting link in it (CAR-175).

- Authoritative: `careervine/src/lib/queries.ts` (header),
  `careervine/src/lib/data/client.ts` (header, and the `must()` docblock),
  `careervine/src/mcp/lib/db.ts` (header)
- Enforced: `careervine/src/mcp/__tests__/db-scoping.test.ts` (a new export
  without a classification entry fails), `careervine/src/__tests__/contact-write-chokepoint.test.ts`,
  the `no-restricted-imports` fences in `careervine/eslint.config.mjs`, and
  `careervine/scripts/check-conventions.mjs` (CI, CAR-158), whose five
  data-layer checks cover what tsc and eslint cannot express: the barrel freeze,
  no module-scope Supabase client under `careervine/src/lib/data` or
  `careervine/src/lib/rules`, the CAS readback shape, unchecked `const { data }`
  reads, and raw query-builder growth in the MCP db module. (The script carries
  eleven checks in total: two further ones on MCP launch flags and test mocks,
  see sections g and h, and four client-state ones, see section f. CAR-190
  corrected a long-standing "four" here and in its own ticket description;
  CAR-208 took the total from twelve to eleven by deleting the duplicate
  overlay check.) Its
  data-layer escape hatches
  both demand a written reason: `// cas-checked:` and `// error-tolerated:`.
  The app-owned-column rule is enforced by
  `careervine/src/__tests__/migration-destructive-guard.test.ts` (authoritative
  header there), which scans `supabase/migrations/` for unguarded destructive
  statements.

## e. Sending email

Two senders, and the direction decides which. `sendAppEmail` is CareerVine
writing to the user over Resend from the careervine.app identity. `sendTrackedEmail`
is the user's own Gmail writing to their contacts.

Everything outbound to a contact goes through `sendTrackedEmail`, which applies
the daily send cap, refuses known-bounced addresses, warns on pattern-guessed
ones, and logs the interaction. Crons are not exempt: they call it like the
interactive paths and catch `SendPolicyError` to defer rather than bypass.

Threading a reply is a second, separate concern. Gmail groups a send into a
conversation from `threadId` alone, so the sender's own mailbox always looks
right; the recipient's client threads on In-Reply-To / References, which must
carry an RFC 822 `Message-ID`, never the Gmail API id the app stores as
`original_gmail_message_id`. Follow-up senders resolve the real ids through
`resolveFollowUpThreadHeaders`, which omits the headers rather than guessing.

- Authoritative: `careervine/src/lib/notify/email.ts`,
  `careervine/src/lib/email-send.ts` (headers), and
  `careervine/src/lib/follow-up-threading.ts` (reply threading)
- Not enforced. Nothing stops a new caller reaching for the wrong one.

## f. Client state

Views stay coherent by broadcasting typed events through
`careervine/src/lib/ui-events.ts` (`emitUiEvent` / `onUiEvent`), never a raw
`window` CustomEvent, so a misspelled event name is a compile error.

Identity-keyed async reads go through `useLatestRequest`: claim a token with
`begin()` when the request starts, gate the state update on `isLatest(token)`, so
a slow earlier response cannot overwrite a newer one.

Client code never calls `fetch` directly, and neither does a browser-reached
helper under `careervine/src/lib`: a relative `/api/...` URL only resolves in a
browser, so it is client code wherever it lives. (That sentence used to stop at
"client code", and six such calls were sitting in `careervine/src/lib` outside the guard's
scope, two of them hand-rolling the error-body parse `apiFetch` exists to
delete. Hoisting a call out of a component into a helper is a refactor a
reviewer would ask for, so the narrower rule was one review away from being
wrong.) "Browser-reached" is decided by IMPORT GRAPH, not by directory: the
guard walks out from the client files and bans every raw `fetch` in what it
reaches (CAR-207). The earlier version tested the URL instead, which a call
taking its path as a PARAMETER slips past entirely — `bundle-apply-client.ts`
POSTed to two `/api/bundles/*` routes from the browser that way for as long as
the guard had existed. Reads go through `apiFetch`, status-only
mutations through `apiSend` (`careervine/src/lib/api-client.ts`, section a), so a
non-2xx throws `ApiRequestError` instead of an error body being read as the
success shape. An interactive handler wraps the call in `withToastOnError`
(`careervine/src/lib/with-toast-on-error.ts`) and gates its state update on the
`true` return. That helper takes caller-written copy and deliberately discards
`ApiRequestError.message`: the route's curated message names the server's
problem ("Follow-up sequence not found"), the handler's names the user's
("Couldn't cancel that follow-up sequence"). Surface the server's own message
only where it is the actionable part, as
`careervine/src/components/settings/provider-key-card.tsx` does
for a key the provider rejected.

Reversible writes are optimistic with rollback plus a toast on failure;
irreversible actions get a confirm modal instead, via `useConfirm()` in
`careervine/src/components/ui/confirm-dialog.tsx` rather than `window.confirm`.

A failed load renders a retryable error state, never the load-empty copy: an
empty list is an affirmative claim about the user's data, and "No email history
found." over a 500 is a lie the user acts on. `LoadErrorState` and its inline
sibling `LoadErrorBanner` (`careervine/src/components/ui/load-error-state.tsx`)
are that state; the banner is for a partial failure beside content worth keeping.

**Load versus resync.** A refetch that follows a write does not always own the
failure, and which case it is decides whether it may stay silent:

- Re-reading after a **failed** write keeps what is on screen and says nothing.
  The toast already fired; blanking the list would complain twice about one
  failure. `careervine/src/components/contacts/contact-follow-up-status.tsx`
  carries the `mode:
  "initial" | "resync"` parameter for exactly this, because its cancel path
  re-reads precisely when the write was refused.
- Re-reading after a **successful** write, on mount, or on an explicit retry
  must not silently render known-stale data. All three surface the failure.
  `careervine/src/components/settings/templates-section.tsx` has no `mode`
  parameter for that reason: no
  path in it re-reads after a failed write, so every caller is the second case.

An error a site genuinely tolerates carries an `// error-tolerated:` comment
saying why, the same escape hatch the data layer uses in section d. The bar is
that the user did not ask for the request and nothing they see depends on it:
analytics, a read-state mirror Gmail re-derives, an opportunistic background
refresh over data already loaded. A bare `.catch(() => {})` is not tolerance, it
is a silent failure.

Double submits are blocked with a synchronous `useRef(false)` (`submittingRef` or
`savingRef`), checked and set before the first await and reset in `finally`. It is
separate from the boolean UI state because a state update is async and would not
block a fast second click.

Every dialog goes through `careervine/src/components/ui/modal.tsx`, which splits
into two layers (CAR-197). `DialogSurface` is what makes something a dialog: the
focus trap, the layer registration, Escape, `role`/`aria-modal`/the accessible
name, the unsaved-changes guard, and the portal context. `Modal` is the M3 chrome
over it — scrim, 28px surface, headline with a close X, padded scrolling body —
and is what a dialog should reach for by default. Reach past it to `DialogSurface`
only when the chrome genuinely cannot be `Modal`'s: a header/scroll/footer layout
its single scrolling body cannot express (compose, follow-up), a bottom sheet (the
conversation modal), or a flow that must not be dismissible (guided onboarding).
Supply the chrome through `wrapperClassName`/`scrimClassName`/`className`, and a
nested confirmation through `overlay` — as a DOM sibling of the surface, because a
nested dialog inside `children` has its keydowns bubble through the outer trap and
the two fight over every Tab.

The trap moves focus into the dialog on open, cycles Tab and Shift+Tab at the
edges, and restores focus to the trigger on close. A form dialog that should open
on a field marks it `data-autofocus`; React's `autoFocus` cannot serve, because
React strips the attribute and focuses imperatively during commit, so the trap's
later effect silently overrode it at every call site. Read the file header before
extending any of this: the tabbable filter deliberately avoids layout checks,
because jsdom has no layout and the usual `offsetParent` filter disarms the trap
under test while still reading as correct.

Both halves of that rule are mechanically enforced (see Enforced, below): a source
scan fails any overlay without a dialog role, and `check-conventions.mjs` carries a
ratchet on the same shape. CAR-190 opened that ratchet at twelve to stop the
hand-rolled side growing while this migration was in flight; the migration landed and
the baseline is now empty, so the two agree.

Two things a modal child must use rather than hand-roll (CAR-198). A child that
portals — a dropdown menu, a popover — portals to `useModalPortalContainer() ??
document.body`, never to `document.body` unconditionally: the trap is
"everything inside the surface", so a menu on the body is keyboard-unreachable
while looking perfectly fine on screen, and `aria-modal` additionally hides it
from assistive tech. That works because the portalled thing is `position: fixed`
and so is not clipped by the surface's `overflow: hidden`, which holds only while
neither the surface nor its wrapper forms a containing block for fixed
descendants; `careervine/src/__tests__/modal.test.tsx` pins both against
`transform`, `filter`, `contain`, `container-type`, `will-change` and friends, in
class, variant, arbitrary-property and inline-style form. And a footer Cancel button or a header X reaches the
dismiss through `ModalCancelButton` / `ModalCloseButton`, not through the caller's
own `onClose`, or it silently skips the unsaved-changes confirmation that the
scrim, Escape and the X all honour. Both are exported from `modal.tsx` and call
`useModalDismiss()` internally; write that hook by hand only for a control those
two do not cover. Worked examples: `careervine/src/hooks/use-portal-dropdown.ts`
and `careervine/src/components/ui/select.tsx` for the portal target,
`careervine/src/components/contacts/contact-edit-modal.tsx` and
`careervine/src/components/contacts/contact-timeline-tab.tsx` for the buttons.
Both rules are adopted by every current call site.

**Any** child that opens and closes owns **Escape while it is open** (CAR-205).
Portalling is not what makes Escape ambiguous; having an open list inside a dialog
is. Without a handler, Escape over an open dropdown closes the dialog underneath it
and leaves the dropdown behind, because the dialog's own handler is a document
listener that fires regardless.

Which mechanism depends on where the panel lives, and the split is not cosmetic:

- **Portalled out of the component's subtree** (`select.tsx`, `use-portal-dropdown.ts`):
  a CAPTURE-phase *document* listener that calls `stopPropagation`. A React handler on
  the wrapper would never see the key, and capture beats the dialog's bubble-phase
  document listener deterministically rather than by mount order.
- **A plain DOM child of the wrapper** (`use-dropdown-escape.ts`, used by
  `contact-picker.tsx`, `month-year-picker.tsx`, `school-autocomplete.tsx` and
  `degree-autocomplete.tsx`): a wrapper `onKeyDown`. The event already passes through
  on its way up, and React attaches its listeners at the root container, which sits
  *below* `document`, so a synthetic `stopPropagation` still stops the dialog's
  handler. No document listener and no `activeElement` heuristic needed.

The portalled form additionally needs an ownership check, and the two worked examples
differ in exactly the part that matters: "does this widget own the key" is
`activeElement === trigger` in `select.tsx`, whose trigger is its only focusable part,
and focus-anywhere-inside-the-widget in `use-portal-dropdown.ts`, whose panels are full
of real buttons. Copying the narrow form into a widget with focusable children
reintroduces the bug for every focus position but one. The check is also what stops a
dropdown left open under a newer layer swallowing that layer's Escape; the wrapper form
gets that for free, since a list that is not focused cannot receive the key. Either way
the handler is gated on `open`, or a closed dropdown swallows the dialog's own Escape,
and focus goes back to the trigger on close, since focus stranded on `<body>` disarms
the enclosing trap.

Not enforced. `careervine/src/__tests__/picker-escape.test.tsx` pins the behavior for
both mechanisms, including that React's synthetic `stopPropagation` really does stop
the document-level handler.

Every dialog surface registers as a dismissal layer with `useDialogLayer()` from
`careervine/src/components/ui/modal.tsx` (CAR-202). Escape is a document-level
event, so without a topmost check one keypress dismisses every open layer, and a
per-dialog scroll lock releases the page under whatever is still open. The hook
answers "am I topmost" at *event* time rather than effect time, since a layer stops
being topmost the moment another opens above it and nothing re-runs its effect; it
also owns the body scroll lock for the stack as a whole. Call it directly only if
you are writing a dialog primitive: `DialogSurface` registers for everything built
on it, which since CAR-197 is every dialog in the app. The one exception is a dialog
rendered *inside* another as its confirmation step, which must not register: the
parent's handler already dismisses it, and registering would make the parent
non-topmost and that branch unreachable. `ConfirmDiscardDialog` is the live example
and the one hand-written overlay left in the codebase.

`<Select>` and `<MonthYearPicker>` take an `ariaLabel` naming the field (CAR-201).
Both render their trigger as a `<button>`, which no visible `<label>` can be
associated with, so without one the accessible name is the trigger's own text —
which, once a value is chosen, is the value. A screen reader user then hears the
value with no way to tell which field they are on.

A subtree that can independently fail gets wrapped in
`careervine/src/components/ui/section-boundary.tsx` so a render throw shows a
retryable panel in that subtree's frame instead of unmounting the page. Do not
hand-roll a class `ErrorBoundary`: it would swallow the sentinel errors
`redirect()` / `notFound()` throw, and would stay stuck in the error state across a
client navigation. Read that file's header before adding a boundary, including the
part about passing a `key` when sections switch by same-route state rather than by
navigation, and about wiring `onReset` so the retry can actually recover. Route-level
boundaries are `careervine/src/app/error.tsx`,
`careervine/src/app/global-error.tsx` and `careervine/src/app/admin/error.tsx`; the
global one replaces the root layout, so it may not import the design system or assume
the global stylesheet, the document head, or any provider survived. All of them report
through the one seam in `careervine/src/lib/report-error.ts`, which is where an
error tracker gets wired (none is installed today). Boundaries catch render throws
only, never a rejected promise in a handler; that is the contract above.

- Authoritative: `careervine/src/lib/ui-events.ts`,
  `careervine/src/hooks/use-latest-request.ts`,
  `careervine/src/components/ui/modal.tsx`,
  `careervine/src/components/ui/confirm-dialog.tsx`,
  `careervine/src/lib/api-client.ts`, and
  `careervine/src/components/ui/section-boundary.tsx` (headers)
- Enforced (adoption, CI): `careervine/scripts/check-ui-events.mjs` bans the raw
  event-name prefix outside the module, and
  `careervine/src/__tests__/select-aria-label.test.ts` scans source and fails on any
  `<Select>` or `<MonthYearPicker>` call site with no `ariaLabel` — a source scan
  rather than a render test because a missing accessible name changes nothing on
  screen and so survives sighted review. `careervine/src/__tests__/dialog-adoption.test.ts`
  (CAR-197) is the third, and covers both halves of the dialog rule: every
  `fixed inset-0` overlay outside the primitive must carry `role="dialog"`/`"alertdialog"`
  or an explicit `non-dialog-overlay:` comment, and every `Modal`/`DialogSurface` call
  site must pass a name. It also asserts that every occurrence of the overlay class is
  one the scanner can *see*, so a class assembled in a const fails loudly rather than
  slipping past a guard that only reads `className` attributes, and that every
  `createPortal` either targets a dialog surface or carries a `body-portal:`
  justification — the rule whose unenforced version let a portalled menu inside a
  trapped dialog become keyboard-unreachable.

  That file is the SOLE enforcer of the dialog rule. `check-conventions.mjs`
  carried a second copy of it until CAR-208 deleted that copy: the two accepted
  near-anagram escape hatches, and neither honoured the other's, so the first
  contributor with a legitimate non-dialog overlay would have written whichever
  token the error they hit first named and stayed red against the other. The
  surviving spelling is `non-dialog-overlay:` (the deleted check's was
  `overlay-not-a-dialog:`, and `careervine/src/__tests__/conventions-doc.test.ts`
  now fails if that retired token reappears in `careervine/src`). The two guards
  were complementary rather than ordered, so the deleted one's detection rule —
  `fixed` and `inset-0` as independent tokens, which catches a reordered or
  interpolated class list — was ported into the survivor rather than lost with
  it.

  `careervine/scripts/check-conventions.mjs` adds four more (CAR-190, CAR-208). Scope is
  `careervine/src/components` + `careervine/src/hooks` + `careervine/src/app`, minus
  the API routes and minus server files (a Route Handler anywhere, or anything under
  `careervine/src/app` with no `"use client"`) — in a server component `fetch` IS the idiomatic
  data call, and `apiFetch` throws outside a browser. The no-raw-`fetch` rule also
  reaches any first-party `/api` call elsewhere under `careervine/src/`:

  | Rule | Shape it fails on | Escape hatch |
  | -- | -- | -- |
  | no raw `fetch(` | any `fetch` in the client tree **or in a module the client tree imports** (runtime edges only, so `import type` does not count), plus a literal `/api/...` URL anywhere else under `careervine/src/` | `// raw-fetch:` |
  | no native confirm | `window.confirm`, or a bare `confirm(` with no **lexically enclosing** binding (`useConfirm()` returns one, so binding is what separates the two) | none |
  | double-submit ref | any async function that writes — whatever it is named, including an inline `onClick={async () => …}` — with no ref both READ in an early return and claimed before the first await | `// reentry-safe:` + ratchet |
  | `useLatestRequest` | a `useEffect`/`useCallback` keyed on an id whose `setState` derives from its own await, gated by neither `isLatest`, a cancellation flag (either polarity, and it must stand between the response and the commit), nor an `AbortSignal` | `// latest-request-exempt:` + ratchet |

  The first two are frozen at zero. The last two ship as **ratchets** over a
  baseline (129 handlers, 6 reads) rather than as the warning CAR-190
  originally proposed, because a warning exits 0 and that is precisely how CAR-154's
  helper decayed to 6 files and CAR-158's to 1. A ratchet fails both ways: an
  offender absent from the baseline fails, and a baselined site that no longer
  offends fails too, so a fix can never be given back.
  `careervine/scripts/lib/ratchet.mjs` holds that algebra and its rationale. Both
  baselines are **named** (one row consumes one slot, so a repeated name cannot ride
  another's entry). An inline JSX handler has no declaration to name, so it is keyed
  by its prop — two `onClick`s in one file are two slots, which the multiset
  accounting already handles.

  Read both numbers as a property of the DETECTOR, not of the codebase, and treat
  every published figure here as provisional. The handler baseline has been wrong
  twice. It was first published as 35; a review found five blind spots (mutations
  carried by `apiFetch`, verbs absent from a hand-written allowlist, every `@/lib`
  module outside a list of five, a write one hop away in a local helper, and a
  guard-recognition rule that accepted refs which guarded nothing) and the figure
  became 54. CAR-208 then found three more — a **handler-name filter** that inspected
  `handleAdd` while ignoring an identical `addContact`, **inline JSX handlers** as an
  entire invisible form, and **non-named import shapes** that bound a seam the scan
  could not resolve — and the figure became 129. The first of those was hiding a live
  gap: the two unguarded submits in the admin contacts card. (An earlier draft
  of this paragraph called that a live double-click bug. It is not one - `Button`
  disables itself from `loading`, and React commits that before the browser
  dispatches a second click, so the second click never reaches the handler. The
  claim was written from the detector's finding rather than from a test, which
  is the failure mode this whole section is about.)

  129 is deliberately an OVER-count, and reading it as 129 double-click bugs would be
  wrong. A callee is judged a write by its verb against a denylist of read verbs, so
  pure helpers whose names do not look like reads count as writes, and a handler one
  hop from a real write counts alongside the helper it calls. That asymmetry is
  chosen: over-inclusion costs a baseline line, under-inclusion costs a live bug.
  Tuning it the other way is how you break it — adding `fetch` to the read verbs, the
  safest-looking addition available, silently un-flagged the most destructive handler
  on the list, because its write goes through a helper called `fetchStepWithRetry`.
  The list has since shrunk from the other end too. CAR-207 drained six entries,
  being the three files it already had open: `data-subscriptions-section.tsx`'s
  `handleSubscribe` and `handleUnsubscribe` (the two this paragraph used to name
  as first to go — non-idempotent, and one POSTs a destructive contact-removal
  loop), `contact-attachments-tab.tsx`'s pair, which got the confirm dialog its
  delete should always have had, and `interactions/page.tsx`, which left **both**
  baselines because that route is now a redirect with no handlers in it. Draining
  the rest is still the mechanical sweep's job.

- Enforced (behavior, no adoption check): `modal.test.tsx` covers the focus
  trap, the `data-autofocus` marker and dialog semantics for both layers, `careervine/src/__tests__/dialog-layer.test.tsx` covers
  the layer stack (topmost-only Escape, shared scroll lock, and the nested-confirmation
  exception), and `careervine/src/__tests__/error-boundaries.test.tsx` pins the
  boundary behaviors, including the `notFound()` re-throw that rules out a
  hand-rolled class, plus source tripwires holding the three existing adoption sites
  to their `key` and `onReset`. Layer registration now comes free with `DialogSurface`, so
  nothing needs to require it separately; nothing yet requires a NEW failure-prone
  subtree to be wrapped in a boundary. `careervine/src/__tests__/use-latest-request.test.tsx`
  pins that the newest request's result survives an older one resolving last, and
  `careervine/src/__tests__/compose-modal-send-guards.test.tsx` pins that a
  double-clicked Send dispatches one POST. (CAR-188 rewrote this sentence from
  three rules to two, correctly dropping optimistic-write rollback, but carried
  the "no coverage at all" claim over to two rules that were already covered.)

  `careervine/src/__tests__/double-submit-guards.test.tsx` and
  `careervine/src/__tests__/outreach-detail-race.test.tsx` cover the four live defects
  CAR-190's audit found while inventorying for those ratchets: two ungated
  identity-keyed reads (the outreach page raced two `getCompanyDetail` calls and
  rendered one company's header over another's employees; the Gmail connection store
  let a stale poll response flip the app back to "Connect Gmail") and two mutation
  handlers whose only guard was `disabled={saving}` (the schedule popover fired one
  POST per Enter keydown at a create-event route with no idempotency key, so key
  repeat produced a row of real Google Calendar events). Note for anyone writing more
  of these: two successive `fireEvent.click` calls do NOT reproduce a double click,
  because fireEvent act-wraps each dispatch and the second lands on an
  already-disabled button. Dispatch both inside one `act()`.

- Enforced (mutation contract, CAR-188 + CAR-204): behavior.
  `careervine/src/__tests__/api-client.test.ts` pins that `jsonBody`'s method
  argument reaches the wire, which ten call sites depend on. `careervine/src/__tests__/confirm-dialog.test.tsx` pins the
  promise contract (every exit path settles, exactly once) and the dialog's
  focus and ARIA; the per-component tests named in
  `careervine/src/__tests__/client-mutation-contract.test.tsx` pin that a non-ok
  response leaves state unchanged and surfaces the failure, and that a failed
  load renders the retryable state rather than the empty one. ("Surfaces"
  rather than "toasts": `ProviderKeyCard`'s failure surface is the inline error
  beside Save, because the editor is open on that path.)

## g. Auth exceptions, secrets, machine tokens, package edges

The 14 routes that deliberately skip `withApiHandler` are named, with the
mechanism each uses, in the `HAND_ROLLED` map in
`careervine/src/__tests__/route-auth-inventory.test.ts`. Five mechanisms are in
play: qstash-signature, bundle-admin-token, webhook-secret, hmac-token, and
oauth-jwks. Adding an unwrapped route under `careervine/src/app/api` without
listing it fails CI, and so does leaving a stale entry behind.

Server-only fence (CAR-158): a module that reads a secret from `process.env`
carries `import "server-only"`, so a client component importing it fails
`next build` instead of shipping the credential read into the browser bundle.
The fenced set, the two written-down exemptions, and the new-module catch live in
`careervine/src/__tests__/server-only-fence.test.ts`. Two non-Next runtimes need
help: `careervine/vitest.config.ts` aliases `server-only` to its own empty
module, and the MCP start script passes `--conditions=react-server`.

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
`careervine/src/__tests__/helpers/fake-calendar.ts`,
`careervine/src/__tests__/helpers/fake-fetch.ts`, and
`careervine/src/mcp/__tests__/helpers/recording-client.ts` for scoping assertions.

A `vi.mock` factory is not typechecked against the module it replaces, so a fake
goes on compiling after the real export is renamed, changes signature, or is
joined by a new one the fake never provides — and because a factory REPLACES the
module rather than merging into it, that new export is `undefined` for every
caller. Mocks of the eight most-mocked modules (the four Supabase client modules,
`auth-provider`, `toast`, and the two analytics modules) go through the shared
factories in `careervine/src/__tests__/helpers/`, which return the module's full
type; `typedMock<typeof import("…")>()` in
`careervine/src/__tests__/helpers/typed-mock.ts` gives a one-off mock the same
constraint. Call a helper INSIDE the factory body (`() => mockXModule()`), never
in argument position: vitest hoists `vi.mock` above the imports, so the helper
binding is not initialized yet. Locals are in TDZ there too, which is why the
factories take per-test overrides as thunks.

A component test that exercises an HTTP call uses `installFakeFetch`, which
routes on `"METHOD /url"` and answers with a real `Response`. The older idiom
in this suite assigns a `{ ok, json }` object literal to `global.fetch` through
an `as unknown as typeof fetch` cast; that literal is never typechecked against
`Response` and usually carries no `status`, so a test asserting through
`apiSend` (whose failure path reads `res.status` and `res.json()`) would prove
the stub rather than the code. An unrouted request throws and is recorded in
`unmatched`; assert `unmatched` is empty (or `countOf` the route you injected),
because the handlers under test swallow rejections and a miss would otherwise
read as the failure the test was written for.

The global environment is node. A DOM test opts in per file with a
`// @vitest-environment jsdom` docblock. jest-dom matchers are not wired, so
assert with `getByText` / `queryByText` rather than `toBeInTheDocument`.

A second tier exists for what mocks structurally cannot express (CAR-178):
`*.itest.ts` files under `careervine/src/__integration__/` run against the
LOCAL Supabase stack (real Postgres, PostgREST, GoTrue, RLS at the full
migration chain) via `npm run test:integration` after `supabase start` from
the repo root. It covers tenant isolation for every RLS table (a new table
fails its completeness guard until it gets a seeded probe or a written
exemption), the scheduled-send claim/race/sweep money path, CHECK-constraint
conformance for every constants.ts vocabulary, and the account-deletion
cascade. Do not port mocked tests into it; the mocked suite stays
authoritative for logic. CI runs it as the separate `integration` job.

Coverage is a gate rather than a report (CAR-186). `npm run test:coverage`, and
the CI `web` job which runs the suite with `--coverage`, measure
`careervine/src/lib`, `careervine/src/hooks` and `careervine/src/mcp`. Two kinds
of regression fail it: global percentage floors catch broad erosion, and
per-area "maximum uncovered units" budgets catch newly added untested code,
which a percentage cannot — one new module is far too small to move the ratio of
a corpus this size past any usable buffer. `careervine/src/components` and
`careervine/src/app` are deliberately unmeasured, because a line number there
rewards render-and-assert-nothing tests; the browser tier owns them. Every
threshold's measured baseline is recorded beside it in the config.

`careervine/src/mcp` joined the gate in CAR-208 and had been outside it since
the gate existed, at 47% statements with `careervine/src/mcp/tools` at 4%. It is
a shipped product surface, it has its own unit tests (eleven files under
`careervine/src/mcp/__tests__`, which is where that 47% comes from), and it is
referenced by neither the integration nor the E2E tier — so what was missing was
specifically a coverage FLOOR: no per-area budget, and far too small a share of
the corpus to move a global percentage, meaning a new untested MCP tool moved no
number and failed no check. Each measured area carries its OWN budget rather than
only feeding the global percentages: a weak area blended into one number hides
behind a strong one, which is exactly what had happened to `careervine/src/hooks`.

- Authoritative: `careervine/vitest.config.ts`,
  `careervine/vitest.integration.config.ts` (header), the header of each
  helper, and `careervine/src/__integration__/helpers/stack.ts` (header)
- Enforced (mocks, CAR-187): the sixth check in
  `careervine/scripts/check-conventions.mjs` fails a `vi.mock` of any of those
  eight modules that does not go through its shared factory (escape hatch
  `// typed-mock-exempt: <reason>`), and
  `careervine/src/__tests__/check-conventions.test.ts` pins that the check
  itself trips. `careervine/src/__tests__/typed-mock.type-test.ts` pins the
  type constraint that backs it: a fake missing an export, naming one that does
  not exist, or disagreeing about a signature is a compile error, while a bare
  `vi.fn()` still satisfies any export.
- Enforced (integration tier): the completeness guard in
  `careervine/src/__integration__/rls-tenant-isolation.itest.ts`
- Enforced (coverage): the thresholds in `careervine/vitest.config.ts`, run by
  the `web` job in `.github/workflows/ci.yml`. The unit tier's remaining
  conventions (reuse of the `fake-*` harness helpers, per-file environment
  opt-in, matcher choice) are not mechanically enforced; the backstop is the
  suite itself passing.

## i. End-to-end tests

A third tier (CAR-189, expanded to nine flows by CAR-191): real Chromium against
a real `next build && next start`,
backed by the same local Supabase stack the integration tier uses. It exists for
the one thing neither other tier can express — whether a change the UI *claims*
to have made actually persisted. Run it:

```
supabase start -x studio,imgproxy,edge-runtime,realtime,storage-api,vector,logflare,supavisor
cd careervine && npm run test:e2e
```

Note the exclusion list is the integration tier's **minus mailpit**. Local auth
runs with `enable_confirmations = true` to match production, so signup sends a
real confirmation email and the flow reads it back; without Mailpit, signup fails
outright. The email templates in `supabase/templates/` are the single source of
truth for both the local stack (via `supabase/config.toml`) and production (via
`careervine/scripts/configure-auth-emails.mjs`).

**Third parties are intercepted in two places, and the split is not optional.**
The calls that matter are made *server-side* — `POST /api/gmail/send` reaches
Google from inside the Next process — and `page.route()` cannot see those.
Stubbing the browser hop instead would skip every server-side write, which is
the thing under test. So: `careervine/e2e/server-stubs/register.mjs` runs MSW
inside the server via `NODE_OPTIONS=--import`, and the `networkGuard` fixture in
`careervine/e2e/fixtures/test.ts` covers browser traffic. Both **deny by
default**: an unstubbed external origin fails the test rather than reaching the
network. That denial is also what makes this tier structurally unable to touch
production, the same guarantee `careervine/src/__integration__/global-setup.ts`
gives the integration tier.

The server half fails the test by being **read back**, not by being logged. Every
denial is appended to a shared file (`STUB_LOG_PATH` in
`careervine/e2e/helpers/ports.ts`), and `networkGuard` asserts this test's slice
of it is empty. A file rather than an endpoint because `NODE_OPTIONS=--import`
arms the stub layer in *every* Node process the webServer command starts —
eleven for one `next build` — so no single process can own the channel. Until
CAR-196 denials were only printed, which produced a real false green: CI run
30139719644 emitted four denied Gmail `labels` calls and reported `5 passed`.
When a spec needs a new external origin, add a handler in
`careervine/e2e/server-stubs/register.mjs`; `networkGuard.allow()` is
browser-side only and does nothing for a call the server makes.

Three checks sit outside the per-test windows, because denials can land outside
them: `careervine/e2e/global-setup.ts` fails the run when the server did not arm
the stub layer at all (which `reuseExistingServer` makes reachable) and when the
build phase reached anything external, and
`careervine/e2e/global-teardown.ts` fails it when a denial arrived after the last
test — background `waitUntil` work is the realistic source.

Wire-shaped fixtures live in `careervine/e2e/fixtures/google-wire.mjs` and its
non-Google sibling `careervine/e2e/fixtures/third-party-wire.mjs`, imported by
the server stub layer — the only layer that fulfils rather than denies, because
no third-party traffic originates in the page.
`careervine/src/__tests__/helpers/fake-gmail.ts` is *not* reusable here: it
doubles the `@googleapis/gmail` client object, not the HTTP body.

Stub responses are FIXED for the whole run — a Playwright worker has no channel
into the Next server process, so a spec cannot vary one. Where a flow needs a
particular value it seeds the database to match the stub, not the reverse:
`calendarSyncEvent` in `google-wire.mjs` returns one event on a known id,
anchored to `Date.now()` so it lands inside the sync route's
`now - 7d` / `now + 60d` window on whatever day the suite runs.

The server's **environment is a closed set**, not the developer's shell:
Playwright merges into the child env and Next loads `.env.local` inside the
server process, so `careervine/e2e/helpers/env-allowlist.ts` closes over all
three sources — it pins every var the app reads, blanks every other key any
`.env*` file defines, and blanks every ambient var that is not OS or toolchain
plumbing. Before CAR-196, seven production values reached the E2E server locally
and none in CI, and sixty-two ambient vars (eleven of them live credentials) went
unfiltered, so a local green and a CI green were not testing the same app. A var
a *dependency* reads must be pinned to a real value rather than blanked: `""` is
absent to a falsy check but not to a `??`, which is how a blanked `QSTASH_URL`
turned into `TypeError: Invalid URL` locally while CI took the SDK default.

Authentication never drives the login form. `careervine/e2e/auth.setup.ts`
provisions a tenant with the integration tier's own `createTenant` /
`seedTenantGraph`, then mints the session by navigating the app's real
`/auth/confirm` route with a service-role `token_hash` — so the cookie is
whatever the app itself writes, with no coupling to `@supabase/ssr`'s encoding.
The signup spec opts out with `test.use({ storageState: { cookies: [], origins: [] } })`.

**One shared tenant, single-worker.** `fullyParallel: false` and `workers: 1`,
so the flows write to one database in file order. Three specs mint their own
identity instead, because the shared one cannot be it: the capability flow needs
a FREE account and the shared tenant is premium (`seedGmailConnection` grants
`modify_scope_granted` and leaves `premium_enabled` at its `NOT NULL DEFAULT
true`, which is why `seedFreeTierConnection` sets that column explicitly rather
than omitting it); the admin flow needs both an admin and a non-admin; and
`settings-keys` destroys more than it can put back. All three opt out of the
project storageState and call `mintSessionUrl` in-test.

A spec that mutates shared state puts it back in `afterEach` — `calendar-sync`
revokes the calendar scope it grants — otherwise a later spec passes or fails on
whether an earlier one ran. `afterEach`, not `finally`: a body abandoned at the
test timeout never reaches a `finally`. Where the damage is wider than the
restore, own a tenant instead: `settings-keys` had an `afterEach` that re-seeded
the Gmail connection it deleted, and `86ca7c2` removed it, because
`POST /api/gmail/disconnect` calls `revokeAccess`, which also nulls two contact
columns and deletes every `email_message` and `calendar_event`. Re-seeding the
connection alone restored one of four things and survived on alphabetical luck.

Selectors prefer `getByRole` / `getByLabel`; `data-testid` appears only where
role plus name is genuinely unreachable. Four kinds qualify, and they are the
whole list: an element with no role (a `type=password` input, a TipTap
contenteditable); an accessible name that is not stable (a row whose name
concatenates a locale-formatted date); two structurally identical components on
one page (the AI tab's provider cards, the integrations tab's two "Disconnect"
buttons); and application STATE that is otherwise reachable only through a style
(`data-unread`, `data-message-id`) — mirror the state into an attribute rather
than asserting on a font weight. Prefer scoping a role query to a container over
adding an attribute. Note `Button` renders an `<a>` when given an `href`, so a
control that looks like a button is often `getByRole("link")`, and that a
`getByText` REGEX matches non-normalized text, so anchoring one on copy that
spans JSX lines breaks on reformatting.

Assertions are web-first — **no `waitForTimeout`, no sleep**. Waiting on
something outside the DOM (a mail delivery, an async POST that fires after its
trigger resolves) uses `expect.poll`.

**Asserting that something did NOT happen needs the causal event first.**
`expect(...)` returns the moment it first passes, so an assertion issued right
after the trigger passes before the thing it is guarding against could possibly
have occurred. Both attempts at this in CAR-191 were green against deliberately
broken code until they were re-sequenced: wait for the real event (a
`page.waitForResponse`, the dialog disappearing), then two `requestAnimationFrame`s
so React has committed anything that event scheduled, and only then assert.
Where a count is available — "the endpoint was never called", via `page.route` —
prefer it to a state comparison, which a slow write wins by default. Neither
technique is an arbitrary wait: both are synchronised to browser events.

- Authoritative: `careervine/playwright.config.ts` (header),
  `careervine/e2e/server-stubs/register.mjs` (header),
  `careervine/e2e/fixtures/test.ts` (header),
  `careervine/e2e/helpers/env-allowlist.ts` (header),
  `careervine/e2e/helpers/tenant.ts` (header), and
  `careervine/e2e/helpers/stack-env.ts` (header)
- Counted: Nine flows live in `careervine/e2e/*.spec.ts`. Pinned by
  `careervine/src/__tests__/conventions-doc.test.ts`, so a tenth cannot silently
  falsify this section.
- Enforced: CI runs it as the separate `e2e` job, with `failOnFlakyTests` so a
  test that only passes on retry exits non-zero rather than printing "flaky" and
  going green. The deny-by-default stub layers are self-enforcing — a new
  external dependency fails the suite by name, on both sides of the split.
  `careervine/src/__tests__/e2e-env-allowlist.test.ts` fails when the app reads
  an env var the allowlist does not pin. Nothing enforces the no-arbitrary-wait
  rule; that one rests on review.
