# CAR-82 — Dedicated Connect Gmail & Calendar step before the company picker

## Problem
Post-CAR-77 the connect chips lived in the picker's sync header and vanished when
the sync finished, so users reached company selection unconnected — undercutting
the flow, which ends by sending an email (needs Gmail). Dawson chose a dedicated,
skippable connect step that gates the picker.

## Changes
1. Migration `20260711220000_onboarding_connect_state.sql`: extend the
   `users_onboarding_state_check` to include `connect`. Validated via rolled-back
   production apply; constraint name confirmed against pg_constraint.
2. `OnboardingState` union + `STATE_RANK`: insert `connect` at rank 1 (between
   not_started and syncing), forward-only preserved.
3. `ConnectStep` component: Gmail + Calendar connect buttons (reused ConnectButton,
   now full-width since it's the only caller), why-it-matters copy, primary
   Continue CTA, standard skip hatch, 3s connection-status poll.
4. Orchestrator: accept → `connect`; new `connect` branch renders ConnectStep;
   continue/skip → `syncing`. `active` set includes `connect`.
5. Removed the connect chips from the picker's sync header (now its own step);
   kept progress bar + gated Select.
6. New analytics event `onboarding_connect_advanced`.
7. Docs (rule 34) + step renumber on docs.careervine.app.

## Verification
`npm run test` (1243 pass, incl. new connect-rank/transition cases) + `npm run build`.
Browser-verify not feasible (needs an authed account in `connect` state); relying on
unit coverage + build.
