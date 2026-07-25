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
- `tabbableWithin` is **unchanged**, and after the slice-2 revision nothing portalled
  is tabbable at all, so the trap's contract stays exactly one sentence.
- The trap's focus restore gains a fallback. A layer can capture as its
  `previouslyFocused` an element that is gone by the time it closes (an open list's
  option is the live case), and restoring nothing there leaves focus on `<body>` —
  outside the surface, where the trap is a keydown handler and therefore silently
  stops running. `<body>` is likewise treated as "nothing to restore" rather than a
  target, which also fixes a scrim-click path that predates this ticket.

### 2. `select.tsx` — real keyboard support, matching what the header already claimed

> **Revised after the deep review.** The first pass moved real DOM focus into the
> portalled options and kept them tabbable. Four independent reviewers traced the same
> consequence: options that hold focus must live somewhere in the tab order, a portal
> can only *append*, so they landed after every other control in the dialog; and
> nothing closed a list the user had tabbed away from, so a stale list's Escape
> handler swallowed Escape for every layer above it — including the unsaved-changes
> dialog, whose buttons then could not be reached at all. Every fix for the stale list
> (close on blur, or close on Tab) also makes "Tab reaches the options" false, so that
> acceptance criterion and a correct dropdown are mutually exclusive. Hence the shape
> below, and the ticket's test list is amended to match.

- Portal target becomes `useModalPortalContainer() ?? document.body`. Required
  independently of focus: `aria-modal` hides everything outside the dialog from
  assistive tech, so a list on the body is invisible to a screen reader.
- Select-only **combobox** per the WAI-ARIA APG: the trigger is the only focusable
  part and keeps DOM focus throughout, with `aria-activedescendant` naming the active
  option. Options are `role="option"` inside a `role="listbox"`, carry no tabindex and
  never take focus — so there is no second focus location to strand, to order, or to
  leak Escape from.
- Trigger: `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`,
  `aria-controls`, `aria-activedescendant`, plus a new `ariaLabel` prop — a `<label>`
  cannot be associated with a button, and once a value is chosen the trigger's text
  *is* the value, so without it a screen reader names the field after its contents.
- Arrows move the active option with wraparound, Home / End jump to the ends,
  Enter / Space commit, Escape closes the list, Tab closes it and moves on.
- Escape stays on a **document keydown listener in the capture phase**, which beats
  the Modal's bubble-phase document listener deterministically, but now fires only
  while this trigger holds focus. The blur-close is what makes a stale list
  impossible; the focus check is belt-and-braces behind it.
- The four other portalling components (`date-picker`, `time-picker`,
  `application-date-picker`, `applications-open-picker`) reach the same contract
  through `usePortalDropdown`, so the rule holds for every portalling child rather
  than just the one that had the live bug.
- Header rewritten to describe what is implemented, and to record why focus stays on
  the trigger instead of asserting the earlier (false) claim that roving tabindex was
  the only alternative.

### 3. `contact-edit-modal.tsx` — the unsaved-changes gap the ticket names

Called out in the ticket's "Live call sites": the modal passes no `hasUnsavedChanges`,
so Escape discards in-progress edits with no confirm. Snapshot the form state in the
same effect that populates it on open, compare against it, pass the result through.
- `useModalDismiss()` is added to `modal.tsx` and the footer Cancel routed through it,
  here and in `add-company-modal.tsx` — the only other modal that sets the guard, and
  the one live violator of the rule this PR writes into CONVENTIONS.
- `handleDelete` no longer closes first: the parent confirms and navigates, so closing
  ahead of it meant a declined confirm shut the modal with the edits gone.
- The populate effect keys on `contact.id`, not the whole object, and clears the
  baseline on close.
- `serializeForm` / `FormSnapshot` are exported for a unit test, and a second
  render-level test file covers the wiring the unit test structurally cannot see.

## Tests

`src/__tests__/select.test.tsx`, `src/__tests__/contact-edit-unsaved-guard.test.tsx`
(both new), and additions to `src/__tests__/modal.test.tsx`:

- **Regression pin** for the original bug, restated for the revised design: the open
  list is a DOM child of the dialog surface (`dialog.contains(option)`, the exact
  inverse of the repro), and portals to `document.body` outside a Modal
- The list stays *out* of the dialog's tab cycle, and focus stays on the trigger for
  the whole interaction
- Escape with the list open closes the list only; with it closed, closes the dialog;
  twice in a row does both in order
- Opening a layer above an open list takes the list down, so Escape reaches that layer
- Arrows with wraparound, Home / End, Enter and Space commit, Tab and blur close
- Empty option list never opens; an empty-string option value and duplicate values
  both navigate correctly
- Combobox semantics: role, `aria-expanded`, `aria-controls`, `aria-selected`, and a
  field name that survives choosing a value
- Unsaved-changes guard at render level: no warning on an untouched open, warning
  after a real edit, Cancel routed through the guard, no warning mid-save, delete
  leaves the form intact, reopen re-baselines
- Source tripwire: neither the surface nor its wrapper declares a containing-block
  property, in class, variant, arbitrary-property or inline-style form

## Verify

`npm run test`, `npm run build`, `tsc --noEmit` and `eslint` from `careervine/`.
In a real browser, since jsdom has neither layout nor sequential Tab: the list renders
unclipped past the dialog's bottom edge, Tab from the trigger moves to the next field
and closes the list, arrows move the active option, Enter commits, and Escape resolves
one layer at a time.

## Reversed after review

The first draft declined to close the list when focus leaves it, calling that "a
nicety, not the defect". It was the defect: four reviewers independently traced a
stale list swallowing Escape for the layer above it. The stated reason for deferring
— that a focus listener would fight the trap's own programmatic focus moves — was also
wrong, since the trap only ever moves focus *out* of the list. Both the call and its
rationale are superseded by slice 2.
