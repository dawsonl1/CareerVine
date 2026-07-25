# CAR-183 — Two silent-failure bugs: follow-up cancel and template delete

Wave 1 of CAR-182. Urgent: bug #1 ships wrong behavior on an outbound-email path today.

## Problem

Two handlers `await fetch(...)` without checking the response, then apply a local
state update that claims the write landed. A rejected promise is the only thing
their `catch` can see, and a 404/500 does not reject — so the optimistic update
always applies.

* `careervine/src/components/contacts/contact-follow-up-status.tsx:35` — UI says
  "Cancelled" while the sequence stays live and the next cron tick emails the
  contact. Confirmed: `DELETE /api/email-follow-ups/[id]` throws
  `ApiError("Follow-up sequence not found", 404)` on an ownership miss, and
  `withApiHandler` maps any `cancelFollowUpSequenceCascade` throw to a 500.
* `careervine/src/components/settings/templates-section.tsx:65` — template
  vanishes from the list, returns on refresh.

## Preliminary research (empirical, not assumed)

Probed the actual harness rather than trusting the docs:

| Question | Finding |
| -- | -- |
| Is `Response` a real global under `// @vitest-environment jsdom`? | **Yes** — undici's. `ok`, `status`, `json()` all behave like production. |
| Does `vi.stubGlobal` restore? | Yes, `vi.unstubAllGlobals()` returns the original identity. The 33 existing component tests assign `global.fetch = vi.fn()` directly, which leaks the stub to later files in the same worker. |
| RTL auto-cleanup / `IS_REACT_ACT_ENVIRONMENT` | Both live (`globals: true` registers RTL's `afterEach`). |
| Is `ToastProvider` an ancestor of both components? | Yes — `src/app/layout.tsx:101`, above every page. `useToast()` is safe in both. Only other layout is `admin/`. |
| Would the change trip `conventions-doc.test.ts`? | No. Its counted claims are routes, schedules, and capability keys — not client-helper adoption. Its cited-path count is a floor (`>= 35`), so adding a citation is safe. |

The important one is the first. Every existing component test hand-rolls
`{ ok: true, json: async () => ({}) }` cast through `as unknown as typeof fetch`.
That literal is not typechecked against `Response` and does not carry `status`.
`apiSend` failure handling reads `res.status` and `await res.json()`, so testing
it against a hand-rolled stub would prove the stub, not the code.

## Test infrastructure

New shared helper `careervine/src/__tests__/helpers/fake-fetch.ts`, alongside the
`fake-gmail` / `fake-calendar` helpers CONVENTIONS.md §h already blesses:

* Routes on `"METHOD /url"` and answers with a **real `Response`**, so
  `apiSend` → `toApiError` → `ApiRequestError` runs its true production path.
* Records every call, so "exactly once" is assertable.
* An unrouted request throws a named error and is recorded in `unmatched`, so a
  component hitting the wrong URL fails loudly instead of getting a silent `{}`.
* Installs via `vi.stubGlobal`, so `vi.unstubAllGlobals()` fully restores.

Rationale for building it here rather than in the sweep: CAR-183 is the first
ticket to put `apiSend` under a component test, CAR-188 (blocked by this one)
migrates 41 more sites that need exactly this, and §h says new tests reuse a
shared harness instead of re-rolling a fake. The file is new, so it cannot
collide with the other four Wave 1 worktrees.

## Fix

Both handlers route through the existing helpers, in the gate form the ticket
prescribes: `apiSend` throws `ApiRequestError` on non-2xx, `withToastOnError`
toasts and returns `false`, and the local state update runs only on `true`.

```ts
const ok = await withToastOnError(
  () => apiSend(`/api/email-follow-ups/${sequenceId}`, { method: "DELETE" }),
  toastError,
  "Couldn't cancel that follow-up sequence. Please try again.",
);
if (!ok) return;
setSequences(/* ... */);
```

Matches the house pattern already in `contact-timeline-tab.tsx`. Deliberately
not changing `withToastOnError` to surface `ApiRequestError.message`: it toasts
its generic argument today across six other files, and rewriting that contract
is a different ticket's blast radius.

`window.confirm` in `templates-section.tsx` stays as-is — owned by CAR-188.

## Tests

Two new jsdom files, per §h (`// @vitest-environment jsdom`, no jest-dom
matchers, assert with `getByText`/`queryByText`). Neither component has a test today.

`contact-follow-up-status.test.tsx`
* 404 leaves the row "1 of 2 sent" and calls the error toast
* 500 leaves the row unchanged and calls the error toast
* a rejected fetch (network failure) leaves the row unchanged and toasts
* 200 applies `cancelled_user` and fires exactly one DELETE, no toast

`templates-section.test.tsx`
* non-ok leaves the row in the list and toasts
* 200 removes the row

## Files

* `careervine/src/components/contacts/contact-follow-up-status.tsx`
* `careervine/src/components/settings/templates-section.tsx`
* `careervine/src/__tests__/helpers/fake-fetch.ts` (new)
* `careervine/src/__tests__/contact-follow-up-status.test.tsx` (new)
* `careervine/src/__tests__/templates-section.test.tsx` (new)
* `careervine/CONVENTIONS.md` §h — name the new helper

## Verify

`npm run test`, `npm run typecheck`, `npm run lint` from `careervine/`.

### Result

All green. `npm ci` was needed first: this worktree's `node_modules` predated the
CAR-178 integration tier, so `pg` was missing and typecheck reported 10 errors,
all inside `src/__integration__/` and none from this change.

| Gate | Result |
| -- | -- |
| `npm run test` | 249 files, 2349 tests passed |
| `npm run typecheck` | 0 errors (run cold, no `.next`, per rule 48) |
| `npm run lint` | 0 problems |
| `npm run build` | success |
| `check:conventions` / `check:ui-events` | pass |

Falsification pass: with the two component fixes stashed and the new tests kept,
all four failure-path tests go red and the two happy-path tests stay green. The
tests fail for the intended reason rather than passing vacuously.

## Deep review round (second commit)

A 5-agent review (3 scope, 1 integration, 1 behavioral) ran against the open PR.
Every finding acted on was re-verified mechanically first, and all of them were
fixed in the same pass rather than deferred.

**Introduced by the first commit:** `fake-fetch` keyed on the raw URL so a `URL`
or `Request` caller could never match a route (both are always absolute);
it captured no `init`, leaving headers and bodies unassertable for CAR-188's
POST sites; it had no test of its own, so its central "real Response" claim was
unpinned and the helper could have been reduced back to an object literal with
the suite still green; two component tests asserted only "a toast happened",
which the harness's own no-route throw satisfies identically; three prose claims
were falsifiable (jsdom does not supply `Response` — Vitest leaves Node's undici
in place; `isolate` defaults to true so a bare `global.fetch =` leaks within a
file, not across files; `calendar-page.test.tsx` does set `status`); and
`installFakeFetch` was named in CONVENTIONS.md without being added to the
`SYMBOL_CLAIMS` guard that exists to stop exactly that rot.

**Pre-existing, same bug class, same two files:** both components swallowed
their READ failures, so a failed GET rendered "No custom templates yet." over
templates that exist and made a failed follow-up read indistinguishable from
"no follow-ups". Both now use `apiFetch` with a distinct retry state. A refused
cancel also left a dead row offering a Cancel button that could never succeed,
so a failed cancel now re-syncs (and a failed re-sync keeps the list rather than
blanking it). `DELETE /api/gmail/templates/[id]` used a bare `parseInt`, so
`"3abc"` deleted a different valid template and `"abc"` reported a client input
error as a 500; it now uses `paramsSchema: idParamSchema`.

**Rejected after verification:** two agents wanted the cancel routes to stop
returning 200 for a no-op on an already-terminal sequence. Both routes carry the
same comment saying cancelling must not rewrite a terminal status, so that is a
documented decision, not an oversight. The client-side mislabel it caused is
fixed by the re-sync instead.

Final: 250 files / 2372 tests, typecheck, lint, build, both guards green, and
CI green on all five jobs (web, mcp, types-drift, integration, extension).
