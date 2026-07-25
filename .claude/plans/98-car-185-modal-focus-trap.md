# CAR-185 — Focus trap for `modal.tsx`

Wave 1 of CAR-182. Single file of product code (`careervine/src/components/ui/modal.tsx`)
plus its test and the one CONVENTIONS.md sentence this change falsifies.

## What is wrong today

`modal.tsx` gives you the scrim, Escape, body scroll lock, and the unsaved-changes
guard. It has no focus management at all. So:

- Tab from the last control moves focus behind the scrim. The user types into a form
  they cannot see.
- Screen readers walk straight out of the dialog into the obscured page, because
  nothing marks the subtree as a dialog.
- Focus is never restored, so a keyboard user loses their place on every open/close.

## Preliminary research, and what it changed

### 1. jsdom cannot do layout, which rules out the usual visibility filter

Probed directly against this repo's jsdom (26.1) rather than assumed:

| API | Result in jsdom | Consequence |
| -- | -- | -- |
| `el.checkVisibility` | **undefined** (not implemented) | feature-detect it; never depend on it |
| `el.offsetParent` | `null` for every element | — |
| `el.getClientRects().length` | `0` for every element | a layout-based "is it visible" filter drops **every** candidate, silently turning the trap into a no-op *in tests only* |
| `"inert" in el` | `false`; `.focus()` still works inside `[inert]` | cannot lean on inert semantics |
| `dialog.showModal` | **undefined** | — |
| `getComputedStyle(el).display` | works (inline styles) | usable, but unnecessary given the above |

The trap therefore filters on **semantics** (`disabled`, negative `tabIndex`, `[hidden]`,
`aria-hidden`, `[inert]` ancestor), and treats CSS visibility as an *optional refinement*
via `el.checkVisibility?.({ checkVisibilityCSS: true }) ?? true`. In a real browser that
excludes `display:none` / `visibility:hidden`; in jsdom it short-circuits to `true` and
the tests still exercise real logic. `checkOpacity` stays off on purpose: an
`opacity: 0` element is still focusable and still in the tab order.

This is the single most important finding. The obvious implementation
(`filter(el => el.offsetParent !== null)`) passes review, ships, and its tests pass
while asserting nothing.

### 2. Native `<dialog>` is the right answer for a greenfield modal, and not for this one

`showModal()` gives a trap, Escape, and correct semantics for free. Rejected because:
jsdom does not implement it (so the whole tier goes dark), `::backdrop` replaces the
existing M3 scrim and its click-to-dismiss wiring, and top-layer promotion changes
stacking against the app's `z-[160]`/`z-[200]` overlays. That is a rewrite of a
component 11 files depend on, not a focus trap.

### 3. Keydown cycling, not a focusin watchdog

APG's own reference wraps Tab in a keydown handler. A capture-phase `focusin` watchdog
that yanks escaped focus back is strictly more robust, but correct nesting then needs a
module-level trap stack so only the topmost dialog reacts. That is materially more
machinery and more risk than the defect warrants, and CAR-192's axe pass plus CAR-189's
real browser are where escape-hatch behavior gets asserted for real. Keydown cycling
covers every requirement on this ticket and is honest about what it does.

APG also confirmed the spec: Tab wraps last→first, Shift+Tab wraps first→last, focus
returns to the invoking element, and `role="dialog"` + `aria-modal="true"` + an
accessible name are required.

## Two things the ticket did not account for

**`ConfirmDiscardDialog` is a second dialog.** It renders as a DOM *sibling* of the modal
surface, not a child, and it is also used standalone at
`careervine/src/components/conversation-modal/index.tsx:553`. One trap on the modal
surface would leave it untrapped in both cases. Because the two surfaces are siblings,
giving each its own trap makes them compose with no coordination at all: a keydown
inside the confirm dialog never bubbles through the modal surface, so neither handler
can see the other's events. No trap stack, no `stopPropagation`, no "am I topmost"
check. Nesting falls out of the DOM shape for free.

Its initial focus lands on **Keep editing**, the first control in DOM order. APG: on an
irreversible operation, focus the least destructive action.

**TipTap is `contenteditable`.** The rich-text editor inside the compose modal is a
`contenteditable` div, not an `<input>`. A selector that omits it drops the editor out
of the cycle, so Shift+Tab from the first control skips it. It is in the selector.

## Design

A local `useFocusTrap(active)` hook in `modal.tsx`, returning a ref for the dialog
surface. Used by both `Modal` and `ConfirmDiscardDialog`.

1. **Containment** — `onKeyDown` on the surface. On Tab, recompute the focusable set
   (per the ticket: these dialogs render conditional controls, so a set cached at open
   goes stale), then `preventDefault` and wrap only at the edges. Intermediate tabs are
   left to the browser, which is what makes the wrap the only asserted behavior and
   keeps jsdom honest.
2. **Initial focus** — first focusable in the surface, else the surface itself
   (`tabIndex={-1}`).
3. **Restore** — capture `document.activeElement` when the layer opens, refocus it on
   cleanup, guarded by `isConnected` so a trigger that unmounted with the modal is
   skipped rather than focusing a detached node. The guard also makes the
   modal/confirm cleanup order irrelevant on the Discard path, where both unmount in
   the same commit.
4. **ARIA** — `role="dialog"` + `aria-modal="true"` on the modal surface,
   `aria-labelledby` to the existing `<h2>` via `useId()`. `ConfirmDiscardDialog` gets
   `role="alertdialog"` with `aria-labelledby` + `aria-describedby`.

## Tests

Extends `careervine/src/__tests__/modal.test.tsx` (jsdom, no jest-dom matchers per
CONVENTIONS §h). `@testing-library/user-event` is not a dependency and the ticket says
no new ones, so Tab is driven with `fireEvent.keyDown` — which is exactly the seam the
trap owns. jsdom does not implement sequential focus navigation, so the non-wrapping
Tab case is deliberately not asserted: it is the browser's job, and faking it would be
asserting the mock.

- focus lands inside the dialog on open
- focus lands on the surface itself when the dialog has no focusable content
- Tab from the last focusable wraps to the first
- Shift+Tab from the first wraps to the last
- focus returns to the trigger on close
- `role`/`aria-modal` present and `aria-labelledby` resolves to the title text
- disabled controls are excluded from the cycle
- the confirm dialog traps independently and opens focus on Keep editing

## Out of scope

Migrating the hand-rolled dialogs to `modal.tsx` (the ticket says so explicitly, and
CONVENTIONS §f flags adoption as even). The pre-existing scroll-lock cleanup quirk
(cleanup resets `document.body.style.overflow` even on renders where `isOpen` was
false) is noted here and left alone: it is a separate defect, unrelated to focus, and
touching it would widen a single-file ticket.

## Verify

`npm run test`, `npm run typecheck`, `npm run lint`, `npm run build` from `careervine/`.
