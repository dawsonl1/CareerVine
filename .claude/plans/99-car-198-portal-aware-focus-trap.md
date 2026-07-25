# CAR-198 — Portal-rendered Select menus inside a Modal are keyboard-unreachable

Live WCAG 2.1.1 Level A regression introduced by CAR-185's focus trap. `select.tsx`
portals its option list to `document.body`; `modal.tsx`'s `tabbableWithin(surface)`
only walks surface descendants, so the open menu sits outside the trap and Tab can
never enter it. Escape hits the Modal's document listener and closes the whole
dialog instead of the menu.

## Approach

The ticket offered two shapes for part 1 and preferred "render the menu into the
modal surface" over "Modal registers satellite containers", because it keeps the
trap's contract as one sentence: *everything inside the surface*. Taking that.

The only real risk in that choice is visual, not semantic: the surface is
`overflow: hidden` with a 28px radius, and the menu is `position: fixed`. **Verified
empirically before committing to the design** (headless Chromium, class-equivalent
DOM): with the menu placed deliberately outside the surface's box,
`elementFromPoint` at the option's centre still returns the option. `overflow: hidden`
does not clip a `position: fixed` descendant, because a fixed element's containing
block is the viewport and clipping only applies down the containing-block chain.

That guarantee holds only while the surface forms no containing block for fixed
descendants, so a `transform` / `filter` / `contain` / `will-change` added to it later
(an entrance animation is the obvious candidate) would silently clip every menu. That
gets a source tripwire rather than a comment.

## Slices

### 1. `modal.tsx` — expose the surface as a portal container

- `useFocusTrap` switches from `useRef` to a **state-backed callback ref**, so the
  surface node is readable during render. Reading `ref.current` in render would work
  today but is impure and would not re-render a consumer if it ever changed.
- New `ModalPortalContext` (the surface element) provided around `children` only, not
  around the confirm dialog, which is a DOM sibling with its own trap.
- Export `useModalPortalContainer()`: the surface when inside a Modal, else `null`.
- `tabbableWithin` is **unchanged**. The menu becomes a real DOM child of the surface,
  so the existing `querySelectorAll` already finds it. No merging of node sets, no
  ordering question: portals append, so options land last in document order, which is
  where the pre-CAR-185 body portal put them too.

### 2. `select.tsx` — real keyboard support, matching what the header already claimed

- Portal target becomes `useModalPortalContainer() ?? document.body`.
- Options stay plainly tabbable `<button>`s. A roving `tabIndex={-1}` would be the
  usual listbox pattern but `tabbableWithin` filters negative tabindex, so it would
  re-break the exact thing this ticket is fixing.
- Trigger: `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`. ArrowDown /
  ArrowUp open the menu and land on the first / last option.
- Menu: ArrowDown / ArrowUp move focus with wraparound, Home / End jump to the ends,
  Enter / Space commit the focused option.
- Escape is handled by a **document keydown listener in the capture phase**, registered
  only while open. Capture on `document` runs before the Modal's bubble-phase document
  listener, so `stopPropagation()` there is deterministic. Relying on React's
  `stopPropagation` from a synthetic handler would work by way of where React 17+
  attaches delegated listeners, which is exactly the kind of subtlety that should not
  be load-bearing for a WCAG fix.
- Every close path that unmounts the focused option (Escape, Enter, click) returns
  focus to the trigger. Without that, focus falls to `document.body` and escapes the
  trap that this ticket exists to repair.
- Header rewritten to describe what is implemented rather than what was aspired to.

### 3. `contact-edit-modal.tsx` — the unsaved-changes gap the ticket names

Called out in the ticket's "Live call sites": the modal passes no `hasUnsavedChanges`,
so Escape discards in-progress edits with no confirm. Snapshot the form state in the
same effect that populates it on open, compare against it, pass the result through.

## Tests

`src/__tests__/select.test.tsx` (new) and additions to `src/__tests__/modal.test.tsx`:

- Tab reaches the options with a Select open inside a Modal
- **Regression pin**: the trap's tabbable set includes the portalled option nodes, and
  Shift+Tab off the Close button lands on the last option
- Escape with the menu open closes the menu only and the dialog stays open
- Escape with the menu closed closes the dialog
- Arrow keys move the active option, with wraparound; Enter commits it
- Escape / Enter / click all return focus to the trigger
- Menu portals to the modal surface inside a Modal, to `document.body` outside one
- Source tripwire: the modal surface declares no containing-block-forming property

## Verify

`npm run test` and `npm run build` from `careervine/`. Manually: Edit Contact, tab to
the phone-type select, confirm the options are reachable and Escape behaves in two
stages.

## Not doing

Closing the menu on focus leaving it. It is a nicety, not the defect, and a
`focusin` listener interacts with the trap's own programmatic focus moves in ways
that would need their own test surface.
