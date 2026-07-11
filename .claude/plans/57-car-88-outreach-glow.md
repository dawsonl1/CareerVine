# CAR-88 — Onboarding outreach: synced pulsing glow (banner + email buttons)

## Problem

When guided onboarding lands the user on a company page (`state === "outreach"`),
nothing visually points them from the instructions banner to the action they
should take. Dawson wants a slow, tasteful pulsing glow on the banner border,
and the *same* glow (in sync) on every active email button, boxed with rounded
corners, so the next click is unmistakable.

## Approach

1. **`src/app/globals.css`** — one `onboarding-cue-pulse` keyframe (soft ring +
   outer bloom, primary-tinted via `color-mix(var(--md-primary))`, theme-aware)
   and a shared `.onboarding-cue` class at a slow 2.6s ease-in-out. Both the
   banner and the buttons use this one class/duration, so they pulse in sync.
   `prefers-reduced-motion` collapses it to a static ring.

2. **`src/app/companies/[id]/page.tsx`** — add `onboarding-cue` to the existing
   outreach banner (drop `shadow-sm` so the glow is the only shadow). Pass
   `highlightEmail={onboardingOutreach && gmailConnected}` into `PipelineLayout`
   (buttons are inert without Gmail, so no glow there).

3. **`src/components/companies/pipeline/pipeline-layout.tsx`** — thread the
   optional `highlightEmail` flag through `PipelineLayout` → `ContactRow` →
   `ContactEmailAction`. When set, the active email button renders as a boxed,
   primary-tinted, ring-1 target with the `onboarding-cue` glow.

## Why gated this way

- Rides the existing `onboardingOutreach` (`useOnboarding().state === "outreach"`),
  so the cue only appears during the guided outreach leg and vanishes when
  onboarding advances. Zero effect for everyone else.

## Verification

- `npm run test` (Vitest) — full suite green.
- `npm run build` — type-check + prod build green.
- Visual: the effect is subjective ("tasteful / looks good"), so demo the exact
  CSS/markup to Dawson for sign-off; real onboarding-outreach state is hard to
  reach in a preview.

## Out of scope / non-existent

- No schema/migration, no new domain, no env. Purely visual + one optional prop.
