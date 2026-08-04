# CAR-205 — Wave 2 regressions and honest load-failure states

Six fixes. One destroys user data; three are regressions introduced by CAR-190 /
CAR-191 / CAR-197; two are pre-existing dishonest empty states.

Research notes below record where the ticket's proposed fix is incomplete, and
what I am doing instead. Three of the six deviate.

---

## 1. Account section overwrites the stored name with empty strings

`careervine/src/components/settings/account-section.tsx`

`getUserProfile` throws on error (`src/lib/data/users.ts:23`). `loadProfile`
catches into `console.error` and still clears `loading`, so the form renders with
`firstName`/`lastName`/`phone` at their initial `""`. `handleSave` then writes
`first_name: ""`, `last_name: ""` to `public.users` **and** to the auth user
metadata. The stored name is gone.

**Fix.** A `loadFailed` state; on failure render `LoadErrorState` (retry
re-invokes `loadProfile`) in place of the profile card and the notifications
card. Both read from the same profile row, so both are lying when it fails.

**Deviation from the ticket:** the password card stays. It depends on nothing
`loadProfile` reads (it goes straight to `supabase.auth.updateUser`), and
removing an unrelated working capability because a different read failed is a
worse outcome than the failure itself.

`handleSave` also gets an early `if (loadFailed) return;`. The form is already
unreachable, so this is a second line of defence, not the fix: this is the one
finding in the audit that loses data, and a later change that moved the error
state to a banner would silently restore it.

## 2. Failed background refresh wipes the outreach people list

`careervine/src/app/outreach/page.tsx`

Render chain is `detailLoading && !detail ? … : detailFailed ? <LoadErrorState/>
: detail ? …`. The company-change effect clears `detail` before loading, so the
error branch is correct there. The compose-close effect (`:159`) refires
`loadDetail()` without clearing `detail`, so a failed refresh over a populated
list replaces good content with the error state.

**Fix.** Gate the full-screen branch on `detailFailed && !detail`.

**Addition beyond the ticket:** that alone makes the refresh failure completely
silent, which CONVENTIONS §f forbids — re-reading after a successful write or on
an explicit retry "must not silently render known-stale data". The compose-close
refresh follows a possible send. So `LoadErrorBanner` (the documented component
for "a partial failure beside content worth keeping") renders above the
surviving list when `detailFailed && detail`.

## 3. Escape closes the dialog instead of the open picker

`careervine/src/hooks/use-portal-dropdown.ts`

No keydown handling anywhere in the hook or its consumers. `modal.tsx:550`
catches the bubbled key on a document **bubble**-phase listener and dismisses the
dialog under the user. Four consumers, not the two the ticket names:
`date-picker`, `time-picker`, `applications-open-picker`,
`application-date-picker`. Fixing the hook fixes all four.

**Fix.** Capture-phase document keydown, `stopPropagation()` + close, mirroring
`select.tsx:137-144`. Capture beats the modal's bubble listener deterministically
regardless of mount order.

**Deviation from the ticket:** the ownership check is *not* a literal mirror of
`select.tsx`. Select gates on `document.activeElement === btnRef.current` because
its trigger is the only focusable part of the widget. These dropdowns contain
real focusable buttons (day cells, hour/minute cells, month chevrons), so the
same check would decline Escape whenever focus sits on a day cell — the exact bug,
in a narrower case. The generalisation is "focus is inside the widget", tested
against the container and the portaled dropdown, which is the same pair the
hook's existing click-outside handler already treats as "inside".

`document.body`/null counts as inside: clicking the panel's own padding blurs to
`<body>`, and a newer dialog opening above would have pulled focus into itself
(the trap focuses on open), so "focus is nowhere" cannot mean a newer layer owns
the key. This preserves the property select.tsx's focus check exists for — a
stale open list must not swallow a newer layer's Escape.

Focus returns to the trigger on Escape-close, so the enclosing dialog's trap
(a keydown handler *on* the surface) keeps working.

## 4. A superseded response tears down the next draft's popover

`careervine/src/components/home/today-schedule.tsx:644`

`creatingRef` is keyed on the draft precisely because the popover unmounts
mid-flight, but the post-await commits are ungated.

**Deviation from the ticket:** the proposed gate,
`creatingRef.current === newEventDraft`, does not fix the reachable case. Draft A
is saved and dismissed mid-flight; the user drags draft B but has not saved it,
so `creatingRef.current` is *still A* and the closure's `newEventDraft` is A —
the gate passes and `setNewEventDraft(null)` still closes B's popover. The gate
only covers the case where B was also saved.

**Fix.** Compare against the live draft rather than the ref, via the functional
updater: `setNewEventDraft((cur) => (cur === newEventDraft ? null : cur))`.
Drafts are fresh objects per drag, so identity is the right key. The `finally`
releases the claim only when it still owns it:
`if (creatingRef.current === newEventDraft) creatingRef.current = null;`.

`onEventCreated?.()` stays **unconditional**. It is `loadSchedule` on the home
page; event A really was created in Google Calendar, and suppressing the refetch
would hide a real event until some unrelated refresh.

## 5. Card padding heuristic is wrong in both directions

`careervine/src/components/ui/card.tsx:67`

Measured rather than assumed. Tailwind v4 emits padding utilities in the order
`p-*` → `px-*` → `py-*` → `pt-*` → `pb-*` (byte offsets in the built stylesheet:
`.p-6` 49483, `.px-6` 50126, `.py-4` 50578, `.pt-6` 51358, `.pb-6` 52263), so the
default's `pb-6` wins over every caller's `py-*` and `px-6` wins over `px-5`.

Live call sites: **10**, matching the ticket's count.

| Call site | Asked for | Actually renders |
| -- | -- | -- |
| `outreach/page.tsx:223` | `py-16` | top 64px, **bottom 24px** |
| `outreach/page.tsx:231` | `py-4 px-5` | **h 24px**, top 16px, **bottom 24px** |
| `outreach/page.tsx:313` | `py-10` | top 40px, **bottom 24px** |
| `companies/page.tsx:222` | `py-16` | top 64px, **bottom 24px** |
| `auth-form.tsx:222` | `px-6 py-8` | top 32px, **bottom 24px** |
| `auth-form.tsx:279` | `px-6 py-8` | top 32px, **bottom 24px** |
| `data-scraping-section.tsx:91` | `py-4` | top 16px, **bottom 24px** |
| `data-scraping-section.tsx:103` | `py-5` | top 20px, **bottom 24px** |
| `data-scraping-section.tsx:125` | `py-5` | top 20px, **bottom 24px** |
| `company-card.tsx:76` | `py-4 px-5` | **h 24px**, top 16px, **bottom 24px** |

The variant direction (`sm:p-8` matching `\bp-\d` and stripping the base padding
below the breakpoint) has **no live call site** today — it is latent, not
shipped. Stating that plainly because the ticket reads as though both directions
are live.

**Fix.** Token-based, base-utilities-only, **per axis**. Splitting on whitespace
and skipping any token containing `:` handles the variant case; classifying each
token by axis handles the rest. Per-axis matters: an all-or-nothing test would
let a caller passing `px-0` silently lose `pb-6` too, which is the same class of
bug being fixed. Arbitrary values (`p-[10px]`) and `!`-important prefixes are
matched by construction rather than by `\d`.

The 17 `p-*` callers are unaffected — they correctly dropped the default before
and still do.

## 6. Two more surfaces render a failed load as "nothing here"

* `careervine/src/app/companies/page.tsx:127` — `LoadErrorState` replacing the
  empty-state card, retry re-invokes `load`.
* `careervine/src/app/contacts/[id]/page.tsx:157` — `loadRelatedData` feeds the
  Actions, Timeline and Attachments tabs (meetings, actions, completedActions,
  interactions, attachments). On failure those three render `LoadErrorState`
  inside the tab frame; the Emails tab is left alone because it reads from
  `loadContactEmails`, which already owns `emailsLoadFailed` /
  `scheduledLoadFailed`. Retry re-invokes `loadRelatedData`.

All of `loadRelatedData`'s four callers are the "must surface" case under §f
(mount, an explicit retry, and two re-reads after a *successful* write); none
re-reads after a failed write, so no `mode` parameter is needed.

---

## Tests

- `account-section`: failed read renders the retryable state, no Save control is
  present, and `updateUserProfile` is never called with empty names.
- `outreach-detail-race.test.tsx`: a failed compose-close refresh keeps the
  people on screen and shows the banner; a failed initial load still shows the
  full error state.
- `use-portal-dropdown`: Escape with a picker open inside a Modal closes only the
  picker and leaves the dialog open; Escape with no picker open still closes the
  dialog.
- `double-submit-guards.test.tsx`: resolving draft A's request while draft B's
  popover is open leaves B open.

  The `finally` half — releasing the claim only when it still holds this draft —
  has **no test**, and that is a finding rather than an omission. One was
  written and thrown away: it passed against the unconditional release it was
  written to catch, because a second Enter on draft B never reaches the
  chokepoint at all (QuickAddCard's own `savingRef` is still latched for B's
  in-flight request and early-returns first). That is the same limitation the
  file already documents for the chokepoint guard itself, and it is now written
  down beside it. The correction stays in: an unconditional release does hand
  back the claim, it is simply unobservable while the popover is the only caller.
- `card.tsx`: base `p-*` replaces, `px-`/`py-` replace per axis, variant-prefixed
  utilities do not suppress the base default.
- `companies` / `contacts/[id]`: failed load renders the retryable state, not the
  empty copy.

## Verify

`npm run test`, `npm run lint`, `npm run typecheck`, `npm run check:conventions`,
`npm run check:ui-events`, `npm run build`, all from `careervine/`.
`check:conventions` carries named ratchets that fail when a baselined site
*stops* offending — `account-section`'s `handleSave`/`handlePasswordChange` are
in the double-submit baseline, and the `loadFailed` guard is state rather than a
ref, so the entries stay valid.

**Every new test is falsified before being kept.** Each fix is patched back out
and the suite re-run, to confirm the right cases go red rather than passing
vacuously. Three of those probes changed the work:

- The ticket's proposed gate for #4 (`creatingRef.current === newEventDraft`)
  leaves the reachable case red, which is what established that deviation.
- `select.tsx`'s trigger-only focus check fails two of the picker cases, which
  is what established that one.
- The `finally` test passed against the broken code and was deleted (above).

Two more probes caught vacuous tests of my own: "returns focus to the trigger"
passed with no picker handler at all (the modal's trap restores focus to the same
element on its way out, so the assertion had to be paired with the dialog staying
open), and the day-cell focus case could pass with focus never having left the
trigger if its selector silently missed.

For #5, the ten call sites' before/after padding is measured in a browser against
the real stylesheet rather than eyeballed:

| Call site | Before | After |
| -- | -- | -- |
| `py-16` (outreach, companies) | T64 R24 **B24** L24 | T64 R24 **B64** L24 |
| `py-4 px-5` (outreach, company-card) | T16 **R24** **B24** **L24** | T16 **R20** **B16** **L20** |
| `py-10` (outreach) | T40 R24 **B24** L24 | T40 R24 **B40** L24 |
| `px-6 py-8` (auth-form ×2) | T32 R24 **B24** L24 | T32 R24 **B32** L24 |
| `py-4` flex (data-scraping) | T16 R24 **B24** L24 | T16 R24 **B16** L24 |
| `py-5` (data-scraping ×2) | T20 R24 **B24** L24 | T20 R24 **B20** L24 |
| `p-7` / `p-6` / `p-8` / `p-14` (17 sites) | T28 R28 B28 L28 | unchanged |

Every change moves the rendered padding *to what the caller asked for*, and the
17 `p-*` callers are byte-identical.
