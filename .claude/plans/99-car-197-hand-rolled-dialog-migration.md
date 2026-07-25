# CAR-197 — Migrate the 12 hand-rolled dialogs onto `modal.tsx`

## Why

CAR-185 gave `careervine/src/components/ui/modal.tsx` a focus trap, `role="dialog"`,
`aria-modal` and a name. Twelve dialogs never went through it, so they have none of
that: a keyboard user tabs straight out of the follow-up modal into the obscured page
behind it, with no announcement. WCAG 2.1.1 Level A, over most of the app's dialog
surface.

It also blocks CAR-192. axe-core has no focus-trap rule at all, and a hand-rolled
overlay with no `role` is not a dialog to axe, so the axe gate would come back green
over exactly these dialogs and the green would read as proof they are fine.

## What is actually there (verified, not assumed)

`grep -rn "fixed inset-0" src --include='*.tsx'` returns 14 hits outside `modal.tsx`:
the 12 on the ticket, plus `ui/confirm-dialog.tsx` (already migrated by CAR-188) and
`onboarding-flow.tsx:68` (the exit-guard `ConfirmDialog`, which has `role`/`aria-modal`
but no trap, no layer and no accessible name pointing at its heading). That 13th
surface is in scope: it is a dialog in the same file as item 8 and it is half-done.

Two corrections to the ticket body:

- **`contact-edit-modal.tsx` already passes `hasUnsavedChanges`** (`contact-edit-modal.tsx:203`,
  wired at `:334`, gated `!saving` with a custom `confirmMessage`). The ticket says it
  passes none. Stale — a later ticket fixed it. Nothing to do there; it is the *model*
  the other dialogs get copied from.
- **`conversation-modal/index.tsx` is not really hand-rolled dismissal.** It already
  imports `ConfirmDiscardDialog` and `useDialogLayer` and re-implements `Modal`'s
  `attemptClose` / `showConfirmDiscard` / Escape-branch verbatim (`:116-151`, `:558`).
  It is a copy of `Modal` minus the trap and the semantics. That is the strongest
  single argument for the extraction below rather than 12 local patches.

## The shape problem

Nine of the thirteen are plain M3 dialogs and drop straight onto `<Modal>`. Four are not:

| Dialog | Why `Modal` does not fit |
| --- | --- |
| `compose-email-modal.tsx` | header / full-bleed To-Cc-Bcc rows with dividers / `flex-1 overflow-y-auto min-h-0` editor / sticky footer. `Modal`'s single `flex-1 overflow-y-auto px-6 pb-6` body would scroll the footer away and indent the dividers. |
| `follow-up-modal.tsx` | same three-zone layout: tabs, own scroll region, own footer. |
| `conversation-modal/index.tsx` | bottom sheet on mobile (`items-end sm:items-center`, `rounded-t-[28px] sm:rounded-[28px]`, `max-h-[100dvh] sm:max-h-[85vh]`, `bg-background`). |
| `onboarding/onboarding-flow.tsx` `StepShell` | deliberately **not dismissible** — no scrim handler, no Escape, no X. `Modal` dismisses on all three. |

Forking `Modal` for those four is what the ticket forbids, and cramming them into it
would be a real visual/behavioral regression. So: **extract the primitive.**

## Design — `DialogSurface`

Add `DialogSurface` to `modal.tsx` and make `Modal` a thin M3-chrome wrapper over it.
`DialogSurface` owns everything that is *dialog* rather than *chrome*:

- wrapper + scrim + surface elements, with all three class strings caller-supplied
- `useFocusTrap` (trap + initial focus + focus restore) and its `onKeyDown`
- `useDialogLayer` (topmost-only Escape + the shared body scroll lock)
- `role` (`dialog` | `alertdialog`), `aria-modal`, and the name via `labelledBy` / `label`
- the unsaved-changes guard: `hasUnsavedChanges` → `ConfirmDiscardDialog` rendered as a
  **DOM sibling** of the surface, with `returnFocusTo={surface}`
- the `ModalContext` provider, so `useModalPortalContainer()` and `useModalDismiss()`
  work inside these dialogs

Props:

```
isOpen, onClose, children,
role = "dialog", labelledBy?, label?,
dismissible = true,          // false ⇒ inert scrim, no Escape (onboarding)
hasUnsavedChanges = false, confirmMessage?,
wrapperClassName?, scrimClassName?, className?,
overlay?                     // extra DOM sibling of the surface
```

`overlay` exists because a nested confirmation must be a **sibling** of the surface, not
a child. `modal.tsx`'s own header explains why: the two Tab traps compose only while a
keydown inside the inner one never bubbles through the outer surface's handler. Two real
call sites need it — `Modal`'s `ConfirmDiscardDialog` (which moves inside `DialogSurface`)
and `StepShell`'s exit guard.

`Modal`'s public API is unchanged except one widening: **`title?: ReactNode`** (was
`string`), because the action-items detail headline is a title plus a priority badge.
All 17 existing `modal.tsx` importers keep working untouched.

### The portal consequence, which is the whole point

`useModalPortalContainer()` returns `null` outside a `Modal`, so every `<Select>`,
`<DatePicker>` and `<TimePicker>` inside these 12 dialogs currently portals to
`document.body`. The moment a trap goes on without the context, those menus land
*outside* the trap and become keyboard-unreachable — this ticket would introduce the
bug it is fixing. `DialogSurface` providing `ModalContext` is what prevents that, and it
is why the fix cannot be "add `useFocusTrap` to each of the 12".

Affected: `ui/select.tsx`, `ui/date-picker.tsx`, `ui/time-picker.tsx`,
`ui/application-date-picker.tsx`, `ui/applications-open-picker.tsx` — all already read
`useModalPortalContainer() ?? document.body`, so they need no edit, only a provider above them.

## Per-dialog plan

**Onto `<Modal>` (8):**

| File | Props |
| --- | --- |
| `app/interactions/page.tsx:140` | `size="md"`, title `New/Edit interaction` |
| `contacts/contact-timeline-tab.tsx:229` | `size="md"`, title `Edit interaction` |
| `contacts/contact-actions-tab.tsx:364` | `size="sm"`, title `New action item` |
| `app/contacts/page.tsx:776` | `size="lg"`, title `New contact` |
| `app/calendar/page.tsx:816` | `size="md"`, title `New/Edit meeting` |
| `app/action-items/page.tsx:730` (detail) | `size="md"`, ReactNode title (name + priority badge) |
| `app/action-items/page.tsx:816` (create) | `size="sm"`, title `New action item` |
| `app/action-items/page.tsx:914` (edit) | `size="md"`, title `Edit action item` |

Each loses its hand-rolled wrapper/scrim/surface and its own Cancel wiring goes through
`useModalDismiss()` so the footer button honours the same guard as scrim/Escape/X.

**Onto `<DialogSurface>` (5):**

| File | Notes |
| --- | --- |
| `compose-email-modal.tsx:734` | keep `z-[100]`, chrome and `handleClose` (save-draft-on-close) as-is; delete its own Escape/layer block. |
| `follow-up-modal.tsx:277` | keep `z-[100]`; delete its own Escape/layer block; wire `hasUnsavedChanges` off a draft snapshot. |
| `conversation-modal/index.tsx:395` | keep `z-[60]` + sheet chrome; **delete** `attemptClose`, `showConfirmDiscard`, the Escape effect and the inline `ConfirmDiscardDialog` — all five are now the primitive's. |
| `onboarding-flow.tsx:108` (`StepShell`) | `dismissible={false}`, `z-[150]`, `bg-black/50` scrim, `p-8` surface, exit guard passed as `overlay`. |
| `onboarding-flow.tsx:68` (`ConfirmDialog`) | `role="alertdialog"`, `z-[160]`, `bg-black/60` scrim; gains trap + layer + `aria-labelledby`. |

Every existing z-index, scrim tint, radius, max-width and max-height is preserved
verbatim. Stacking order does not change.

### `hasUnsavedChanges`

Wired where the dialog holds in-progress edits, using `contact-edit-modal`'s pattern (a
serialized pristine snapshot compared against the live form, gated on `!saving` so a
save in flight cannot offer to discard writes it cannot stop): interactions, timeline
edit, actions-tab create, contacts create, calendar meeting form, action-items
create + edit, follow-up drafts. Not the action-items detail modal (read-only), not
compose (it already persists a draft on close, which is strictly better than a confirm),
not onboarding (not dismissible).

## Tests

Reuse the `modal.test.tsx` shapes rather than re-rolling them — the `fireEvent.keyDown`
Tab helper and the jsdom-safe assumptions in that file are load-bearing.

- `modal.test.tsx` — new `DialogSurface` block: role/name/`aria-modal`, `dismissible={false}`
  (inert scrim, Escape does nothing), `overlay` renders as a sibling of the surface,
  context reaches children, guard fires on all dismiss paths.
- New `dialog-adoption.test.ts` — source tripwire in the shape of
  `select-aria-label.test.ts`: any `fixed inset-0` JSX outside `modal.tsx` must carry
  `role="dialog"`/`role="alertdialog"`, with a documented escape-hatch comment for a
  genuine non-dialog overlay. This is the guard CAR-190 was going to grow; it belongs
  here, in the branch that makes it pass. Without it the 13 migrations are one
  copy-paste away from being 14 hand-rolled dialogs again.
- Per-migrated-dialog render tests: opens with focus inside, Tab and Shift+Tab cycle,
  Escape and scrim both restore focus to the trigger, `aria-labelledby` resolves to the
  real heading text.
- Update `onboarding-confirm-dialog.test.tsx` (its scrim assertion queries `.bg-black\/60`)
  and any of the 12 tests in `src/__tests__` that assert on the old DOM.

## Verify

`npm run test` and `npm run build` from `careervine/`. Baseline before any change:
268 files / 2636 tests, all green.

Then re-run CAR-192's axe measurement against a migrated dialog and confirm it now
appears to axe as a dialog — the specific claim that unblocks that ticket.

## Docs

`CONVENTIONS.md` §f currently says modal adoption "is currently even with hand-rolled
dialogs, so this rule is forward-looking rather than descriptive", and the `useDialogLayer`
paragraph names the three hand-rolled full-screen modals by path. Both become false in
this branch and get rewritten, along with the "Enforced" list (the new source tripwire
is an adoption check, which that list says does not exist).
