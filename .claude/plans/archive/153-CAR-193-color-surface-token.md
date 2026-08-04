# CAR-193 — `bg-surface` emits no CSS: missing `--color-*` theme tokens

## Problem

`careervine/src/app/globals.css`'s `@theme inline` block never declared
`--color-surface`. Tailwind v4 only emits a utility for a token declared there,
so `bg-surface` was not a utility at all: no rule, no error, element renders
transparent.

Verified at runtime on a clean dev server against the pre-fix file: no
`.bg-surface` rule in any loaded stylesheet, and the class computes to
`rgba(0, 0, 0, 0)` while its declared sibling `bg-surface-container` correctly
computes to `#fafafa`.

## Scope grew during the work

The regression guard written for `surface` immediately flagged **four more
tokens with the identical defect**, each confirmed at runtime (baseline
computed values, against `text-primary`/`text-destructive` controls that work):

| Token | Utilities | Sites | Visible today |
| --- | --- | --- | --- |
| `surface` | `bg-surface` | 24 | No (latent) |
| `error` | `text-/bg-/border-error` | 23 | **Yes** |
| `on-primary` | `text-on-primary` | 8 | **Yes** |
| `on-error` | `text-on-error` | 1 | **Yes** |
| `on-tertiary` | `text-on-tertiary` | 1 | **Yes** |

The four `error`/`on-*` tokens are not latent. In production right now:

- `modal.tsx:199` — the "Discard" destructive button renders as **transparent
  background with dark text** instead of red-with-white. It reads as plain text,
  not a button.
- `checkbox.tsx:45` — the checked tick is near-black on the green
  `bg-primary` box instead of white.
- `action-items-section.tsx:90` — the selected "Waiting on them" pill is dark
  text on dark teal.
- `outreach/page.tsx:365` — the `bounced` email warning is not red.
- `transcript-viewer.tsx:11` and 20 other `text-error` sites render as ordinary
  body text.

`surface` alone is invisible today: all 24 sites resolve to a
`min-h-screen bg-background` (#ffffff) shell, which is the exact color
`bg-surface` was meant to paint.

## Fix

Five declarations in `@theme inline`:

```css
--color-surface: var(--md-surface);
--color-on-primary: var(--md-on-primary);
--color-on-tertiary: var(--md-on-tertiary);
--color-error: var(--md-error);
--color-on-error: var(--md-on-error);
```

## Regression guard

`src/__tests__/theme-tokens.test.ts` — scans `:root` for `--md-*` color
variables, scans source for `<prefix>-<token>` utilities over the app's own M3
vocabulary, and fails on any token used but not re-exported through `@theme`.
Mutation-tested: removing `--color-surface` or `--color-error` fails it;
restoring passes.

## Verification

- **`surface` is a pixel-level no-op in real contexts.** Full-page before/after
  screenshots of a harness rendering all affected wrappers: section A (real
  `#ffffff` backdrop, all 24 sites) is byte-identical; the only changed rows
  (1471-2650) fall entirely inside the synthetic elevated-container section
  (1422-2700), which is the latent bug being fixed.
- **The four `error`/`on-*` tokens are visible corrections**, captured
  before/after on a cache-cleared dev server.

## Out of scope, filed separately

`* { border-color: var(--md-outline-variant) }` (globals.css:128) is
**unlayered**, so it beats every layered Tailwind utility: *all* `border-<color>`
utilities are dead app-wide, including Tailwind's own `border-red-500` and the
`focus:border-primary` focus rings. Confirmed on a real rendered element
(`border-error/40` stays `rgb(225,227,230)` while its sibling
`bg-error-container/40` applies correctly). Separate root cause with app-wide
visual blast radius, so it gets its own ticket and its own visual review rather
than riding along here.
