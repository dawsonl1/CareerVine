# Accessibility Audit — CareerVine web app

**Date:** 2026-07-17
**Scope:** `careervine/src/app/**` and `careervine/src/components/**`
**Method:** Static source audit (read + targeted grep) of dialogs/modals, focus management, keyboard operability, icon-only controls, form labeling, images, ARIA roles/semantics, and color-contrast tokens. No browser/AT run — findings are code-derived and each carries `file:line` + a concrete fix.

## Summary

The app is built on a Material-3-inspired component layer that gets the **easy** things right — semantic color tokens (body text `text-muted-foreground` ≈ 6:1 on white, passes AA), `alt` on the one real content image (`contact-avatar`), correct decorative `alt=""` on company logos, `<html lang="en">` on both the app shell and the docs page, and a handful of well-labeled controls in the pipeline/date-picker widgets.

The **systemic** gaps are all in the interaction layer:

1. **Dialog semantics are almost entirely absent.** Only 3 of ~15 modal surfaces expose `role="dialog"`/`aria-modal`. The shared `ui/modal.tsx` and every roll-your-own modal render as anonymous `<div>`s.
2. **No focus management anywhere.** There is no focus trap, no focus-return-on-close, and several dialogs never move focus in. Nothing in the tree implements Tab-cycling or restores focus to the trigger.
3. **Icon-only controls are broadly unlabeled.** ~35 `aria-label`s exist against far more icon-only buttons/links. The custom `Tooltip` is CSS-only and gives its trigger **no** accessible name, so every control that leans on it (nav Inbox/Calendar/Admin, discovery dismiss, etc.) is anonymous to a screen reader. Most `<X>` close buttons have no label.
4. **The custom `Select` documents keyboard nav it does not implement** and renders its options in a `document.body` portal, outside the trigger's focus order.
5. **The auth form labels its inputs with placeholder text only.**

None of these fully lock a keyboard user out (no hard keyboard traps), so nothing is ranked **blocker**, but the modal + labeling gaps are real **serious** barriers for screen-reader and keyboard-only users across the primary flows.

**Total findings: 19** (7 serious, 7 moderate, 5 minor). One finding is in the cold zone (`reset-password`) and is proposed as a verbatim fix; the rest are report-only (HOT trees or non-cold components).

---

## Directories / files examined (no silent gaps)

**Read line-by-line:**
- `src/app/`: `layout.tsx` (lang), `auth/page.tsx`, `reset-password/page.tsx`, `oauth/consent/page.tsx`, `privacy/page.tsx` (partial), `terms/page.tsx` (links)
- `src/components/ui/`: `modal.tsx`, `tooltip.tsx`, `toggle.tsx`, `checkbox.tsx`, `select.tsx`
- `src/components/`: `navigation.tsx`, `auth-form.tsx`, `contacts/contact-avatar.tsx`, `follow-up-modal.tsx`, `conversation-modal/index.tsx`, `setup-banner.tsx`, `settings/templates-section.tsx`, `companies/discovery-card.tsx`, `home/today-schedule.tsx`, `home/log-conversation-fab.tsx`, `ai-write-dropdown.tsx`
- `public/docs/index.html` (cold zone; interactive-element scan)

**Scanned via cross-cutting grep across ALL of `src/app` + `src/components`** (not every file opened line-by-line): `<img>`, `<div/span onClick>`, `aria-label`, `role="dialog"`/`aria-modal`, `keydown`/`Escape`, `.focus()`/`autoFocus`, `<X>` close icons, `<Tooltip>` usage, `title=`, hardcoded low-contrast Tailwind (`text-gray/slate/zinc/neutral-300/400`), color tokens in `globals.css`.

**Signal-only (grep-covered, not individually read)** — flagged so the gap is explicit: `src/components/admin/*`, most `src/components/settings/*`, `src/components/companies/pipeline/*`, `src/components/onboarding/*`, `src/components/home/*` (beyond the two read), `src/components/ui/{date-picker,time-picker,month-year-picker,application-date-picker,applications-open-picker,degree-autocomplete,school-autocomplete,state-select,contact-picker,rich-text-editor,toast,button,card}.tsx`, `intro-context-form`, `transcript-uploader/viewer`, `speaker-resolver`, `availability-picker`, `quick-capture-modal`, `capable`, providers. Where these surfaced in grep results they are cited below.

**HOT files** (report-only, never proposed for edit) that appear in findings: `src/components/email/inbox/inbox-shell.tsx`, `compose-email-modal.tsx`, `contacts/contact-edit-modal.tsx`, `contacts/contact-info-header.tsx`, `src/app/{contacts,calendar}/**`.

---

## Findings (ranked)

### SERIOUS

#### S1. Shared `Modal` has no dialog semantics, no focus trap, no focus return, no accessible name
`src/components/ui/modal.tsx:131-158` (surface `<div>` at :140; scrim at :134)
The reusable dialog renders as plain `<div>`s. It is missing: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the title `<h2>` (:144), a focus trap (Tab escapes to the page behind the scrim), initial focus into the dialog, and focus return to the trigger on close. It *does* handle Escape (:92-112) and lock body scroll — good, but that is the only piece present.
**Impact:** every consumer of `<Modal>` inherits all of these gaps. Screen-reader users are not informed a dialog opened and can Tab into the inert background; keyboard focus is lost on close.
**Fix:** on the surface `<div>`, add `role="dialog" aria-modal="true"`, give the `<h2>` an `id` and set `aria-labelledby` to it (or `aria-label` when `title` is absent). On open, move focus to the first focusable element (or the dialog container with `tabIndex={-1}`); capture the previously-focused element and `.focus()` it back on unmount. Add a Tab/Shift-Tab wrap handler (or adopt `focus-trap-react`).

#### S2. Roll-your-own modals also lack `role="dialog"`/`aria-modal` (systemic)
Confirmed instances (dialog surface `<div>` with a `bg-black/*` scrim sibling, no dialog role):
- `src/components/follow-up-modal.tsx:284` (scrim) / surface below it
- `src/components/conversation-modal/index.tsx:388-393`
- `src/components/ui/modal.tsx` → `ConfirmDiscardDialog` `:40-42`
- `src/app/interactions/page.tsx:128`
- `src/app/action-items/page.tsx:707, 793, 891`
- **HOT (report-only):** `src/components/compose-email-modal.tsx:663`, `src/app/contacts/page.tsx:751`, `src/app/calendar/page.tsx:756`, `contacts/contact-edit-modal.tsx`, `contacts/contact-timeline-tab.tsx:214`
Only `onboarding/onboarding-flow.tsx:68`, `ui/application-date-picker.tsx:223`, and `ui/applications-open-picker.tsx:387` set the role correctly.
**Fix:** same as S1 per surface, or refactor these onto the shared `<Modal>` once S1 is fixed.

#### S3. Icon-only controls have no accessible name because `Tooltip` supplies none
`src/components/ui/tooltip.tsx:28-38` renders the label as a **sibling** `role="tooltip"` span that is never referenced by the trigger (no `id` + `aria-describedby`, and it provides no `aria-label`). It is a purely visual hover/focus affordance.
Consequently these icon-only controls are announced as unnamed:
- `src/components/navigation.tsx:85-102` (Inbox), `:106-115` (Calendar), `:119-128` (Admin) — each is a `<Link>` whose only child is a lucide `<svg>`.
- `src/components/companies/discovery-card.tsx:137-143` (Dismiss), and its sibling action button in the same `<Tooltip>` group.
- Other `<Tooltip>`-wrapped icon triggers in `admin/*`, `pipeline-layout.tsx`, `contacts/page.tsx`, `admin/users/page.tsx`.
**Fix (two options):** (a) give each icon trigger its own `aria-label` (the Tooltip stays purely visual), **or** (b) make `Tooltip` render an `id` on the label span and set `aria-describedby` on the trigger — but note `aria-describedby` is *description*, not *name*, so an `aria-label` on the trigger is still required for the name. Simplest correct fix: add `aria-label` to every icon-only trigger.

#### S4. Icon-only `<X>` close/remove buttons missing `aria-label`
Confirmed unlabeled (icon-only `<button>` whose only child is `<X>`):
- `src/components/ui/modal.tsx:145-150` (shared close button)
- `src/components/follow-up-modal.tsx:299-305`
- `src/components/conversation-modal/index.tsx:401-406`
- `src/components/settings/templates-section.tsx:104-110`
- `src/components/ui/contact-picker.tsx:74` (remove chip)
- `src/components/meetings/transcript-action-suggestions.tsx:318`
- `src/components/companies/pipeline/manage-offices-panel.tsx:119`
- `src/components/contacts/contact-follow-up-status.tsx:104`
- **HOT (report-only):** `compose-email-modal.tsx:680, 1153`, `email/inbox/inbox-shell.tsx:1221`, `contacts/contact-edit-modal.tsx:456`, `contacts/contact-info-header.tsx:605`, `src/app/contacts/page.tsx:936`, `src/app/calendar/page.tsx:640, 788`
**Fix:** add a descriptive `aria-label` to each (`"Close"`, `"Remove application"`, `"Remove tag"`, etc.).
Note: `setup-banner.tsx:87-93` and `home/today-schedule.tsx:247-254` use `title="Dismiss"/"Close"` — this yields a (weak) accessible name, so they are acceptable but should migrate to `aria-label` (see M-minor list).

#### S5. Custom `Select` documents keyboard nav it does not implement; options escape focus order
`src/components/ui/select.tsx`
- The header comment (:6-9) claims "Keyboard navigation (arrow keys, Enter, Escape)" but there is **no** `onKeyDown` anywhere in the file. No arrow-key roving, no Enter-to-select-on-focused-option, no Escape-to-close (only outside-`mousedown`, :61-69).
- The trigger button (:100-110) has no `aria-haspopup="listbox"`, no `aria-expanded`, and the menu has no `role="listbox"`/`role="option"` semantics.
- The menu renders via `createPortal(..., document.body)` (:112/:137), so it is appended at the end of `<body>`. Tabbing off the trigger moves focus to the next in-DOM control, **not** into the option list; the options are only reachable by tabbing to the very end of the page.
- No focus is moved into the menu on open and none returns to the trigger on close.
**Impact:** a keyboard user can open the menu (button is operable) but cannot navigate it in a predictable order; a screen-reader user gets no combobox/listbox affordance. This is the app's primary form dropdown.
**Fix:** add `role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId}` to the trigger; `role="listbox"` on the menu and `role="option" aria-selected` on each item; implement ArrowUp/Down roving + Enter/Escape; move focus into the active option on open and back to the trigger on close. Either keep the portal and manage focus manually, or render in-place.

#### S6. Auth form inputs are labeled by placeholder only; show/hide-password toggle is unlabeled
`src/components/auth-form.tsx`
- `firstName` (:320-330), `lastName` (:334-344), `email` (:352-362), `password` (:369-380) each have an `id` but **no** associated `<label htmlFor>` and no `aria-label`; the only text is `placeholder`. Placeholder is not an accessible name (it disappears on input and is unreliably exposed).
- The show/hide-password toggle (:381-387) is an icon-only `<button>` (`<Eye>/<EyeOff>`) with no `aria-label`.
**Impact:** the sign-in / sign-up / reset flows — the app's front door — present unnamed fields and an unnamed control to AT. (This is a `src/components` file, not the cold `src/app/auth` page, so it is report-only.)
**Fix:** add a visually-hidden `<label htmlFor>` (or `aria-label`) to each input; add `aria-label={showPassword ? "Hide password" : "Show password"}` + `aria-pressed={showPassword}` to the toggle.

#### S7. No focus management across dialogs (initial focus / return / Escape gaps)
Cross-cutting. Beyond S1/S2:
- Several dialogs never move focus in on open (e.g. `conversation-modal`, `follow-up-modal`).
- No dialog restores focus to its opener on close (no captured-element `.focus()` anywhere).
- Page-level modals with **no Escape handler at all** (not in the keydown grep set): `src/app/contacts/page.tsx`, `src/app/action-items/page.tsx`, `src/app/interactions/page.tsx`, `src/app/calendar/page.tsx` (page-level meeting form), and `quick-capture-modal.tsx` — dismissal is backdrop-click or the (unlabeled) `<X>` only.
**Fix:** standardize on the fixed shared `<Modal>` (S1) so initial focus, focus return, focus trap, and Escape are handled in one place; migrate the page-level modals onto it.

### MODERATE

#### M1. `reset-password` labels are not associated with their inputs  *(COLD — fix proposed)*
`src/app/reset-password/page.tsx:97` and `:110`
`<label className={labelClasses}>New password</label>` / `Confirm new password` wrap nothing and have no `htmlFor`; the inputs (:98-107, :111-118) have no `id`. Clicking the label does not focus the field and AT does not associate the name. (WCAG 1.3.1 / 3.3.2.)
**Fix (proposed verbatim in `proposedColdEdits`):** add `htmlFor="new-password"`/`"confirm-password"` to the labels and matching `id` to the inputs.

#### M2. `Toggle` switch has no accessible-name mechanism
`src/components/ui/toggle.tsx:10-27` renders `role="switch" aria-checked` but exposes no `label`/`aria-label`/`aria-labelledby` prop, so callers cannot name it and every instance is an anonymous switch unless coincidentally wrapped.
**Fix:** add an optional `label`/`ariaLabel` prop and apply it as `aria-label` (or wire `aria-labelledby` to adjacent text) on the button; require callers to pass one.

#### M3. `Checkbox` name relies on a wrapping `<label>` around an ARIA `role="checkbox"` button
`src/components/ui/checkbox.tsx:23-52` wraps a `role="checkbox"` `<button>` and a sibling `<span>{label}</span>` in a `<label>`. Implicit `<label>` association is reliable for native form controls, but name computation for a `<button>` whose role is overridden to `checkbox` is inconsistent across browsers/AT, so the visible `label` text may not be exposed as the control's name.
**Fix:** give the `<span>` an `id` and set `aria-labelledby` on the button (or pass the text as `aria-label`). Verdict: PLAUSIBLE (browser-dependent) — worth hardening since it is a shared primitive.

#### M4. Clickable `<div>` rows without `role`/`tabIndex`/keyboard handler  *(HOT — report-only)*
- `src/components/email/inbox/inbox-shell.tsx:979` (expand email row) and `:1366` (open draft row): `cursor-pointer` `<div onClick>` with no `role="button"`, `tabIndex={0}`, or key handler — not keyboard-focusable/operable.
- `src/app/calendar/page.tsx:430`: whole-page `<div onClick>` to deselect; benign but non-semantic.
**Fix:** convert the interactive rows to `<button>` (or add `role="button" tabIndex={0}` + Enter/Space handlers).

#### M5. Form-control border color fails non-text contrast (WCAG 1.4.11)
`src/app/globals.css:22` `--md-outline: #bdc1c6`, used as the default `border-outline` on inputs/selects (e.g. `auth-form.tsx:105`, `select.tsx:104`). `#bdc1c6` on white `#ffffff` ≈ **1.83:1**, below the 3:1 required for control boundaries. (Focus state uses `border-primary`, which passes.)
**Fix:** darken the resting input border toward `--md-on-surface-variant` (`#5f6368`, ≈6:1) or a token ≥3:1 on white; keep `--md-outline-variant` for decorative dividers only.

#### M6. Modal backdrop `<div onClick>` has no keyboard equivalent (systemic, low harm)
Every roll-your-own modal uses `<div className="...bg-black/32" onClick={close}>` (e.g. `follow-up-modal.tsx:284`, `conversation-modal/index.tsx:390`, `interactions/page.tsx:128`, `action-items/page.tsx:707/793/891`). Click-outside-to-close is fine as a *supplementary* affordance, but only works because Escape/close-button should also exist — which per S4/S7 they sometimes don't.
**Fix:** ensure each such dialog also has Escape + a labeled close button (covered by S1/S4/S7); the backdrop `<div>` itself needs no role since it is redundant.

#### M7. Collapsed FAB has an empty accessible name
`src/components/home/log-conversation-fab.tsx:122-164`. The button's only always-present text is `{FULL_TEXT.slice(0, displayedChars)}` (:158), which is empty while collapsed (`displayedChars === 0`); the full-text measurer span is `aria-hidden` (:150). So on initial render the FAB is a `<Plus>`-icon-only button with no name.
**Fix:** add `aria-label="Log a conversation"` to the button.

### MINOR

#### m1. Low-contrast decorative spinner
`src/components/email/email-experience.tsx:11` `text-gray-400` (`#9ca3af` ≈ 2.5:1 on white) on the loading `<Loader2>`. It sits inside `role="status" aria-label="Loading"` (:10), so the state is announced; the color is only a visual nicety. Prefer `text-muted-foreground` for consistency.

#### m2. Icon buttons named via `title=` instead of `aria-label`
`setup-banner.tsx:91` (`title="Dismiss"`), `home/today-schedule.tsx:253` (`title="Close"`), `navigation.tsx:139` (settings avatar `title="Settings"`). `title` produces a slow, unstyled tooltip and an accessible name that some AT ignore. Works, but migrate to `aria-label`.

#### m3. Docs tablist missing `aria-controls`/`aria-labelledby` wiring and roving keys
`public/docs/index.html:484-502`. Tabs have `role="tab" aria-selected`, panels have `role="tabpanel"`, but tabs lack `aria-controls={panelId}` and panels lack `aria-labelledby={tabId}`; there is no ArrowLeft/Right roving between tabs. Low impact (docs reference page, content also reachable by scrolling).
**Fix:** add the id cross-references and arrow-key handling to the tab script.

#### m4. `Select`'s hidden native validation select is correctly hidden — verify no double-announce
`src/components/ui/select.tsx:84-98` mirrors the value into an `aria-hidden`, `tabIndex={-1}` native `<select>` purely for `required` validation. This is correctly hidden from AT; noting only so it is not "fixed" into visibility. No action.

#### m5. Fallback avatar initial has no text alternative
`src/components/contacts/contact-avatar.tsx:93-99` renders a single initial in a `<div>` with no `aria-label`/`role="img"`. Harmless where the contact name is adjacent (the common case), but standalone uses (chips) expose only a letter. Optional: add `role="img" aria-label={name}` on the fallback.

---

## Cold-zone proposed fixes

Only `src/app/reset-password/page.tsx` (M1) is in the cold zone. Four verbatim edits associate the two labels with their inputs via `htmlFor`/`id`. Everything else above is in HOT trees or non-cold `src/components`, and is report-only. See `proposedColdEdits` in the structured output.

## What's already good (no action)

- Semantic color tokens: body/muted text ≈ 6:1 on white (AA pass); hardcoded low-contrast Tailwind is essentially absent (one decorative spinner).
- `contact-avatar` uses `alt={name}`; company logos use correct decorative `alt=""`.
- `<html lang="en">` on the app shell (`layout.tsx:90`) and docs (`index.html:2`).
- `oauth/consent` wraps inputs inside `<label>` (implicit association — correct).
- `docs/index.html` menu toggle, section anchors, and decorative SVGs are labeled (`aria-label`, `aria-hidden`).
- The date-picker / pipeline widgets carry the majority of the codebase's `aria-label`s and set `role="dialog"` on their popovers.
