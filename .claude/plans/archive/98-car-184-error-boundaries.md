# CAR-184 — App Router error boundaries: no render throw should blank the page

Wave 1 of CAR-182. Branch `dawson/car-184-test-infrastructure-cdf7e2` (the worktree
slug is a misnomer inherited from the parent program's name; this ticket is error
boundaries, not test infrastructure).

## Baseline, re-verified in this worktree

| Claim | Result |
| -- | -- |
| `error.tsx` / `global-error.tsx` / `loading.tsx` anywhere in `src` | 0 |
| `ErrorBoundary` / `componentDidCatch` / `getDerivedStateFromError` in `src` | 0 |
| `@sentry` or `Sentry.` in `src` or `scripts` | 0 (not installed) |
| Layouts in the app tree | exactly 2: `app/layout.tsx`, `app/admin/layout.tsx` |
| Next / React installed | `next 16.2.10` (pinned, no caret), `react 19.2.7` |

So the ticket's premise holds. Two facts it did not have change the design.

## Research finding 1 — Next 16.2 ships a framework-aware boundary; use it

The ticket specifies a hand-rolled class `ErrorBoundary` ("React still has no hook
form"). True of React, but Next **16.2.0** added `unstable_catchError` from
`next/error`, and it is present in the installed 16.2.10
(`node_modules/next/error.d.ts` re-exports it; impl at
`dist/client/components/catch-error.js`). Reading that impl, it does three things a
hand-rolled boundary gets **wrong**:

1. **`getDerivedStateFromError` re-throws `isNextRouterError(error)`.** `redirect()`,
   `notFound()`, `forbidden()`, `unauthorized()` all work by throwing sentinel
   errors. A hand-rolled boundary *catches* them and renders "Something went wrong"
   where the user should have been redirected. This is a latent bug the naive spec
   would introduce, and it matters here: `app/admin/layout.tsx` redirects non-admins
   and `contacts/[id]` is a dynamic route.
2. **`getDerivedStateFromProps` clears the error when the pathname changes.** A
   hand-rolled boundary stays stuck in the error state after a client navigation, so
   a user who trips an error on one contact sees the error panel on the next contact
   too.
3. **`unstable_retry()` refreshes inside `startTransition`**, preserving client state
   outside the boundary. `reset()` only clears error state without re-fetching.

Cost: the `unstable_` prefix. Contained by importing it in **exactly one module**
(`section-boundary.tsx`), so a rename is a one-line change, plus a guard test that
fails loudly if the export disappears on a Next bump.

### Empirically verified, not just read

A throwaway probe (`src/__tests__/zz-probe-catcherror.test.tsx`, run then deleted)
proved all five behaviors under this repo's jsdom + RTL setup, with no App Router
runtime present — 5/5 passing:

* catches a render throw and renders the fallback
* `reset()` re-renders children once the throw is fixed
* `unstable_retry()` does not throw with no `AppRouterContext` (`this.context?.refresh()`
  is optional-chained, so it degrades to a plain reset)
* **re-throws `notFound()`** rather than swallowing it
* a sibling boundary keeps rendering when one trips

Three jsdom hazards checked in the source and cleared: `isBot()` matches only
Googlebot / html-limited crawlers (jsdom's UA is not one, so the error path is not
skipped); `handleISRError` no-ops when `window` is defined; `useUntrackedPathname()`
returns `null` with no provider, and `null !== null` is false so the pathname reset
does not misfire.

## Research finding 2 — `global-error` gets no global styles

Per the 16.2 docs: `global-error` "render[s] its own document and do[es] **not**
include your global styles". It replaces the root layout, so Tailwind classes and the
Geist font variables are not guaranteed to reach it. It also cannot export
`metadata` (it is a Client Component); use React's `<title>`.

→ `global-error.tsx` is written with **inline styles only** and zero imports from
`@/components` or `@/lib`. If the root layout crashed, none of the design system or
the seven context providers it mounts can be assumed to work.

## Structural consequence: both route files are load-bearing

`error.tsx` wraps `page.tsx`, `loading.tsx`, and *nested* layouts, but **not** the
layout in its own segment. `app/layout.tsx` mounts seven client providers
(`AuthProvider`, `AnalyticsProvider`, `ToastProvider`, `ComposeEmailProvider`,
`OnboardingProvider`, `ExtensionOnboardingProvider`, `QuickCaptureProvider`,
`SignedOutRedirect`). A throw in any of those bubbles straight past `app/error.tsx`.
That is exactly the gap `global-error.tsx` closes, so this is not belt-and-braces.

Conversely `app/error.tsx` renders *inside* those providers, so it may use the design
system freely.

## Files

**New**

* `src/app/error.tsx` — root segment boundary. Prefers `unstable_retry`, falls back
  to `reset`. Reports via the shared reporter. Design-system styling, keeps nav usable.
* `src/app/global-error.tsx` — own `<html>`/`<body>`, inline styles, React `<title>`,
  no app imports.
* `src/app/admin/error.tsx` — `app/admin/` has its own layout, so its own boundary.
* `src/components/ui/section-boundary.tsx` — `unstable_catchError`-based reusable
  section boundary. Props: `label?`, `onReset?`, `className?`. Copy matches
  `LoadErrorState`, the existing honest-failure component, so the app fails one way.
* `src/lib/report-error.ts` — one-function seam (`reportBoundaryError`). Sentry is not
  installed and the ticket says not to add it in this diff, so it `console.error`s
  with a stable prefix. Wiring Sentry later is a one-file change. Noted on the ticket.
* `src/__tests__/error-boundaries.test.tsx` — the tests below.

**Edited (JSX wrapping only)**

* `src/components/email/inbox/inbox-shell.tsx` — wrap the seven tab panels (the
  `<>…</>` at ~595-625).
* `src/app/calendar/page.tsx` — wrap the children of the `weekShellRef` div
  (~510-692), so the grid *and* the event bubble are contained while the page header,
  nav, and the List/Week toggle stay alive. A user whose week grid breaks can still
  switch to List.
* `src/app/contacts/[id]/page.tsx` — wrap the tab content `<div>` children (~317-380).

### The `key` idiom (design detail worth stating)

The boundary self-clears on **pathname** change, but all three adoption sites switch
sections via **same-route state**, not navigation. Without a key, a tripped Drafts tab
would keep showing the error panel after switching to Inbox. So each site passes
`key={activeTab}` (calendar: `key={view}`), remounting the boundary on section change.
Documented in the `section-boundary.tsx` header.

## Copy (rule 35: no em dashes)

* Section: "Something went wrong loading this section." + "Try again"
* Route: "Something went wrong." + supporting line + "Try again"
* Global: "Something went wrong." + "Reload the page"

No stack traces, no error codes, no `error.digest` in the UI. `error.message` is
generic in production for server-thrown errors by design, and leaking it adds nothing
for the user.

## Tests

`src/__tests__/error-boundaries.test.tsx`, jsdom, per the ticket:

1. a child that throws renders the fallback, not a blank tree
2. `reset()` (via the fallback's Try again) re-renders the child once fixed
3. a sibling section keeps rendering when one section's boundary trips

Plus, earned by the research:

4. `notFound()` is re-thrown, not swallowed — pins the property that motivated
   choosing `unstable_catchError`, so a future swap to a hand-rolled class fails
5. `unstable_catchError` is still exported from `next/error` — turns a Next rename
   into a red test instead of a runtime break
6. the three route boundaries render their copy and call the reporter; `global-error`
   renders its own `html`/`body`

Console noise: React logs caught errors via `console.error`. Each throwing test spies
and restores, so the suite stays clean without globally muting a real signal.

## Verify

* `npm run test` from `careervine/`
* `npm run typecheck` and `npm run lint` **cold**, with `.next` moved aside (rule 48:
  CI runs both before Build, so `.next/types` is absent there)
* `npm run build`

> **Correction (post-review).** An earlier draft of this plan claimed the build
> machine-checks the `error.tsx` prop signatures. It does not: `.next/types/validator.ts`
> contains no error-component validation, so Next never typechecks these props against
> its own expectation. The signatures were instead verified by reading
> `node_modules/next/dist/client/components/error-boundary.js`, which renders the error
> component with `{ error, reset, unstable_retry }` at line ~107, making the declared
> subset correct.

## Post-review addendum: the recovery contract

The deep review found that the plan above was incomplete in one important way. Wrapping
alone gives a retry button that cannot work: `unstable_retry`'s `router.refresh()` does
not re-run a client component's `useEffect` loaders or replace parent-held `useState`,
and every wrapped subtree here is a presentational leaf whose data lives in the page
above it. Two bugs followed, both confirmed by independent reviewers with probes:
"Try again" was a no-op at all three sites, and a *successful* refresh from elsewhere on
the page (the inbox Sync button) left the stale error panel on screen.

The fix is the RECOVERY CONTRACT documented in `section-boundary.tsx`: every site wires
`onReset` to its existing retry closure, and a site that keeps its subtree mounted
during a refresh (contact detail) also carries a data generation in the boundary `key`.
The calendar's `key={view}` turned out to be dead code and was removed, since its
enclosing `view === "week"` conditional already unmounts the boundary.
