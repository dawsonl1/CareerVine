# CAR-188 — Finish the client mutation contract

Wave 2 of CAR-182. Blocker CAR-183 is **Done and merged** (PR #167); CAR-189 is
merged too (PR #172), and its `test.fail()` pin was already removed on main in
`8abde90`, so coordination note item 1 needs no action here.

## Scope, as corrected

The ticket description was written against a 34-commit-stale tree and the
`<!-- audit-corrections -->` comment widens it. Re-measured on this branch
(level with `origin/main` at `dcdc053`):

| Claim in the description | True today |
| --- | --- |
| 116 `fetch(` sites | **118** total; **111** in `components/`+`app/` excl. `app/api/**`, 6 in `hooks/`, 1 server-side third-party call |
| 41 unchecked | ~36, but see below |
| `apiFetch`/`apiSend`: 1 file | **3** |
| `withToastOnError`: 6 files | **8** |
| 10 `window.confirm` | **12** in 9 files; only 2 are `window.`-qualified |

**This ticket takes all 111 + the 6 in `hooks/`, not the unchecked subset.**
CAR-190's guard 1 bans *every* raw `fetch(` under `src/components/**` and
`src/app/**` with only a `// raw-fetch:` hatch for streaming/third-party/blob.
Scoping to the unchecked subset would leave ~35 sites across 23 files that no
ticket owns, and guard 1 would go red on day one naming all of them. The
already-`.ok`-checked 75 are a mechanical swap; taking them is cheaper than
arguing about them later.

The one site that is genuinely out of scope is
`src/app/api/settings/deepgram-key/route.ts:32` — server-side, third-party
(api.deepgram.com), and outside guard 1's path filter.

## A. Fetch migration

Rules, per the ticket and CONVENTIONS.md §a:

- **Reads** → `apiFetch<InferApiResponse<typeof GET>>` where the route exports a
  usable handler type, so an error body cannot typecheck as success. Where the
  route is hand-rolled or the inferred type is unusable, an explicit interface.
- **Status-only mutations** → `apiSend`.
- **Interactive handlers** → `withToastOnError`, state update gated on `true`.
- **Failed primary load** → `LoadErrorState` (or `LoadErrorBanner` for a partial
  failure beside surviving content), never the load-empty copy.
- **No bare `.catch(() => {})`.** A tolerable error carries
  `// error-tolerated: <why>`, matching the hatch `check-conventions.mjs`
  already recognizes for the data layer.

**`withToastOnError` stays as it is.** It takes fixed caller-written copy and
discards `ApiRequestError.message`. That is the right default: the route's
curated message ("Follow-up sequence not found") is worse UI copy than the
handler's ("Couldn't cancel that follow-up sequence. Please try again."). Where
a site *already* surfaces the server's message inline — `provider-key-card`'s
key-validation errors are the clear case — it keeps doing so by catching
`ApiRequestError` at that site rather than by changing the helper.

Order of work, largest surfaces first so the shared patterns settle early:
`compose-email-modal.tsx` (13), `email/inbox/inbox-shell.tsx` (11),
`contacts/contact-emails-tab.tsx` (8), `app/calendar/page.tsx` (7), then the
long tail, then the nine `components/admin/*-section.tsx` files, which are near
identical and migrate as a batch.

## B. Confirm migration

New `components/ui/confirm-dialog.tsx`: a `ConfirmDialog` plus a `useConfirm()`
hook, built on `modal.tsx`'s `useFocusTrap` (currently module-private — export
it rather than duplicating the jsdom-aware tabbable filter, whose header
explains why it must not use layout checks).

**It takes a `message` prop.** `provider-key-card.tsx:179` passes
`config.removeConfirm`, the only one of the twelve that is not a string literal;
a dialog designed against the ten listed literals would ship without one and
the API-shape error would propagate past this ticket.

Twelve sites, with the audit's corrected line numbers:

`settings/integrations-section.tsx:87,104` · `settings/provider-key-card.tsx:179`
· `settings/templates-section.tsx:75` · `contacts/contact-timeline-tab.tsx:50` ·
`app/interactions/page.tsx:91` · `app/contacts/[id]/page.tsx:217` ·
`app/admin/users/page.tsx:169` · `app/calendar/page.tsx:291` ·
`app/meetings/page.tsx:416,464,620`

Copy is preserved verbatim, restyled only. No em dashes (rule 35). The
`/admin/users` bulk toggle ("Turn X ON/OFF for ALL accounts?") gets the
destructive-variant treatment: it is the only one that writes across every
account.

## C. Three logic bugs

1. **`lib/change-events/change-events.ts:168` `markChangeEventStatus`** never
   reads the update's `error`. supabase-js resolves rather than throws, so a DB
   failure currently returns `200 {success:true}` from both
   `/api/change-events/dismiss` and `/api/suggestions/save`. Fixing the client's
   `res.ok` check is meaningless until this does. → `must()`.
2. **`hooks/use-suggestions.ts:96` `dismiss`** filters the card out of local
   state, then fires an unchecked POST with `.catch(() => {})`. At 500/401/network
   the card vanishes, the row stays `'new'`, and it returns on the next load. The
   line-94 comment asserts the opposite of what the code does.
3. **`app/page.tsx:699` `handleSnooze`** correctly skips the cooldown when
   `saveSuggestionRaw` returns false, then unconditionally calls
   `dismissSuggestion` and toasts "Snoozed for 7 days." For a change-event-backed
   suggestion that destroys the row server-side while claiming a snooze. This is
   a category a `fetch(` grep cannot surface: *handler ignores a boolean success
   return*. Sweep for siblings while in the file.

Also `app/page.tsx`: `:227` swallows the calendar sync failure, `:238`'s
`if (eventsRes.ok)` has no else, `:292`'s catch is commented `// silent`, and
there is no `scheduleError` state at all, so a connected user whose events API
500s sees a bare hour grid. `TodayScheduleProps` needs an error prop.

## D. CONVENTIONS.md §f — the load-vs-resync rule

The two CAR-183 reference files disagree in shape, so this ticket replicates
whichever an agent opens first. Write the rule down:

- refetch compensating for a **failed** write → keep what is on screen, stay
  silent; the toast already fired
- refetch after a **successful** write → must not silently render known-stale
  data; a failure here gets its own state

`contact-follow-up-status.tsx`'s `mode: "initial" | "resync"` is the correct
shape. `templates-section.tsx` reconciles to it.

## Tests

Per migrated component, at minimum: a non-ok response leaves state unchanged and
surfaces a toast; a failed load renders the retryable error state and not the
empty state. Through `installFakeFetch` (real `Response` objects, so
`apiSend`'s `res.status` / `res.json()` failure path is exercised rather than a
stub), asserting `unmatched` is empty so a wrong endpoint cannot pass silently.
jsdom per-file docblock, no jest-dom matchers (§h).

New: `confirm-dialog.test.tsx` covering the focus trap, Escape, the destructive
variant, and that `onConfirm` runs only on confirm.

## Verify

`npm run test`, `npm run lint`, `npm run build`, `npm run check:conventions`
from `careervine/`. Then re-run the two inventories and confirm zero raw
`fetch(` outside the hatch and zero `confirm(` in the guarded paths, which is
the precondition CAR-190 is blocked on.

## Parallelism

Wide surface, and both named conflicts are already merged (CAR-189 #172,
CAR-183 #167). CAR-184's error boundaries and CAR-186's coverage thresholds are
on main. Merge `main` in before opening the PR regardless.
