# CAR-200 / 201 / 202 / 203 — the four CAR-198 review follow-ups

All four came out of the CAR-198 deep review and were filed instead of fixed. That was
the wrong call (rule 44: a defect you have already diagnosed is work, not a question —
and opening a ticket is a form of deferral, not an exemption from it). One PR, all four,
no subsets.

The branch carries `CAR-200`, so the hooks bind there; 201/202/203 are driven by hand.

---

## CAR-200 — MonthYearPicker corrupts free-form graduation values

`contacts.expected_graduation` is `text` and documented free-form by
`20260214073000_add_contact_status.sql`. Four shapes actually reach it:

| Shape | Written by |
| --- | --- |
| `"2026-05"` | `MonthYearPicker` itself |
| `"May 2027"` | `deriveContactStatus` (`lib/profile-helpers.ts:124`, extension `profile-format.ts:86`) |
| `"2027"` | `deriveContactStatusFromDates` (`lib/profile-helpers.ts:159`, `String(latestEndYear)`) |
| `"2026-04-10"` | full ISO dates, exercised by `suggestion-generators.test.ts` |

The picker assumes only the first. `parseInt("May 2027")` is `NaN`, `NaN !== null` is
true, and `NaN ?? fallback` does not fall back, so the trigger renders **"undefined NaN"**,
the calendar header renders `NaN`, and picking a month emits **`"NaN-05"`**, which saves.

The downstream consumer is tolerant — `generate-suggestions.ts:115` does
`new Date(value)`, which parses all four shapes — so this is the picker's bug alone and
needs no data migration.

**Fix.** A single `parseMonthYear` that accepts all four shapes and returns
`{ year, month }` with `month` null for year-only, or null when nothing parses.

- Unparseable and non-empty renders **the raw stored text**, not the placeholder.
  Showing the placeholder would tell the user the field is empty when it is not, and
  that is how you get a value silently overwritten.
- `viewYear` is re-seeded from the value on every open. It was `useState(...)` seeded
  once at mount, so a value arriving or changing later left the calendar on the wrong
  year — latent today, and it would come back the moment `NaN` stopped masking it.
- Emission is `${viewYear}-${mm}` with `viewYear` proven finite, so `NaN-05` is
  unrepresentable.

Two things the file already claimed but did not have, fixed while here rather than
written down as a lie:

- The header promised a **Clear button**. There was none, and with `contact_status`
  still `student` there was no way to unset a graduation date at all. Added — it is also
  the escape hatch for a contact whose stored value cannot be parsed.
- The trigger is a `<button>` whose accessible name is its own text, i.e. the value:
  the same CAR-201 defect. It takes an `ariaLabel`, plus `aria-haspopup`/`aria-expanded`.

## CAR-201 — 17 Selects announce their value as their name

WCAG 4.1.2. `Select`'s trigger is a `<button>`, a visible `<label>` cannot be associated
with one, so the accessible name is the trigger's text — which once a value is chosen
*is the value*. CAR-198 added `ariaLabel` and wired 4 sites; the rest are done here.

Mechanical, so the interesting part is the guard. The failure is invisible to sighted
review and to every existing test, so `select-aria-label.test.ts` scans every `.tsx`
under `src/` and fails on a `<Select` opening tag with no `ariaLabel`. It matches the
opening tag by brace depth rather than by regex, so a nested `{cond ? <X/> : <Y/>}` in a
prop does not end the tag early.

## CAR-202 — stacked dialogs share one Escape and one scroll lock

Each open dialog adds its own document/window `keydown` listener with no topmost check,
so one Escape dismisses every open layer, and whichever effect cleans up first sets
`body.overflow = "unset"` while the others are still open.

The ticket's reachability note calls the two-`Modal` case unconfirmed. The **reachable**
instance is `ConfirmDialog` over `Modal`: Edit Contact → Delete opens the parent page's
`useConfirm` dialog over the still-open modal, and Escape there both cancels the delete
*and* dismisses the edit modal behind it. Fixing the hypothetical case and leaving that
one would be pointless, so the primitive is adopted at every `aria-modal` surface in the
app rather than at the one the ticket named:

`useDialogLayer(active)` in `modal.tsx` — a module-level stack of open layers. Returns
`isTopLayer()`, evaluated at **event** time, not effect time, since the stack changes
under a mounted listener. It also owns the scroll lock: locking is exactly the question
"is any layer open", and the count is already there. The previous `overflow` value is
captured on the first lock and restored on the last release, rather than assuming
`"unset"`.

Adopted by `Modal`, `ConfirmDialog`, `FollowUpModal`, `ComposeEmailModal` and
`ConversationModal`. The last three are full-screen `fixed inset-0` overlays that never
locked scroll at all, so they also stop letting the page scroll behind them.

`ConfirmDiscardDialog` deliberately does **not** register: it is a DOM sibling *inside*
`Modal`, and `Modal`'s handler already branches on `showConfirm`. Registering it would
make the Modal non-topmost and that branch unreachable.

## CAR-203 — delete `contact-info-header.tsx`

An unreferenced 700-line duplicate of the contact edit form. No importer in `src`, no
dynamic import, no string reference; the 2026-07-17 dead-code audit reached the same
conclusion and deferred removal to "the owning wave/ticket", which is this one. It has
been carried through eight refactors since (CAR-114, 120, 138, 154, 155, 158, 173) —
maintenance paid on code that never renders. It also holds 3 of the `<Select>` sites
CAR-201 would otherwise have to label.

---

## Tests

- `month-year-picker.test.tsx` (new) — all four stored shapes render correctly and emit
  well-formed `YYYY-MM`; `"May 2027"` specifically never yields `undefined NaN` or
  `NaN-05`; unparseable text shows as itself; clear emits `""`; reopening re-seeds the
  year.
- `select-aria-label.test.ts` (new) — the source guard above, plus a self-check that it
  actually finds the call sites (a scanner matching nothing passes vacuously).
- `dialog-layer.test.tsx` (new) — Escape with two layers open dismisses only the top;
  the scroll lock survives the inner layer closing and releases on the last; the
  reachable `ConfirmDialog`-over-`Modal` case explicitly.
- `modal.test.tsx` — `ConfirmDiscardDialog` still answers Escape through the Modal.
- Falsify each: revert the fix, confirm the intended test goes red.

## Verify

`npm run test`, `npm run build`, `tsc --noEmit`, `eslint` from `careervine/`.
Browser check for the picker, since jsdom has no layout: real graduation values render,
the grid highlights the right month, and the page behind a stacked dialog stays put.
