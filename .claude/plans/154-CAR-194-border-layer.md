# CAR-194 — unlayered `* { border-color }` kills every border-color utility

## Problem

`careervine/src/app/globals.css:139`:

```css
* {
  border-color: var(--md-outline-variant);
}
```

This sits **outside any cascade layer**. `@import "tailwindcss"` puts all of
Tailwind's output into layers (`theme`, `base`, `components`, `utilities`), and
an unlayered rule beats every layered rule regardless of specificity. So this
one declaration overrides all border-color utilities app-wide.

Confirmed on a real rendered element: `border-error/40` computes
`rgb(225,227,230)` while its sibling `bg-error-container/40` applies correctly on
the same node. Tailwind's own `border-red-500` loses too, which rules out a
missing-token cause (that was CAR-193).

## Blast radius

447 usages / 66 files, but the distribution matters more than the count:

| Group | Count | Effect of the fix |
| --- | --- | --- |
| `border-outline-variant` (no alpha) | 170 | **None** — same color the `*` rule already forces |
| `border-outline-variant/{20..60}` | ~102 | Gains intended translucency, slightly lighter |
| `border-primary` + alpha + `focus:` | ~85 | Renders green; focus rings start working |
| `border-outline` | 36 | Slightly darker (`#bdc1c6` vs `#e1e3e6`) |
| `border-{error,destructive,tertiary,secondary-container,amber}` | ~15 | Intended semantic colors |
| `border-transparent`, `border-background` | 4 | Actually transparent / white |

So roughly 170 sites do not move at all, ~140 shift subtly, and ~85 become
visibly correct.

## The most user-visible bug this fixes: loading spinners

The standard spinner in this codebase is

```
animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent
```

The `*` rule overrides **both** `border-primary` and `border-t-transparent`, so
the ring renders a uniform light gray with no contrast gap. The element is still
spinning, but a gapless uniform ring has no visible rotation. Every spinner in
the app currently reads as a static gray circle. Appears on the home dashboard,
contacts list and detail, interactions, calendar, and more.

## Fix

Move the default into the `base` layer so utilities can win:

```css
@layer base {
  * {
    border-color: var(--md-outline-variant);
  }
}
```

Same layer as Tailwind's preflight, declared after it, so it still overrides
preflight's `currentColor` default for elements with no border utility, while
`utilities` (a later layer) now correctly beats it.

## Verification plan

- Runtime probe: `border-primary`, `border-error`, `border-red-500`,
  `border-transparent` each compute their own color.
- Spinner before/after, since it is the clearest visible regression being fixed.
- Audit page rendering every distinct border utility from the table above, on
  both the white shell and an elevated container, captured before/after.
- Regression guard so an unlayered rule cannot silently outrank utilities again.
