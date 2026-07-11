# CAR-84 — Confirmation prompts on every onboarding exit path

## Goal
Reduce guided-onboarding drop-off: intercept every in-flow exit with a stay-nudge.

## Changes
- New exported `ConfirmDialog` (modal-on-modal, z-160). Stay button emphasized;
  scrim click = stay. Reused for both prompts.
- `StepShell`: the "Skip for now" hatch (offer, connect, picker — all skip paths)
  now opens the cancel-onboarding confirm; the real onSkip fires only on "Cancel
  onboarding". One change covers every skip path.
- `BundleOfferStep`: "No thanks" opens the data-bundle confirm (PM-recruiting
  caveat); onDecline fires only on "Skip it".
- Copy has no em dashes (CAR-72).

## Copy
- Cancel-onboarding: "Are you sure you want to cancel the onboarding?" / "It only
  takes about 4 minutes, and it teaches you important ways to use CareerVine that
  you'd likely miss on your own." Stay="Keep going", Leave="Cancel onboarding".
- Bundle decline: "Skip the recruiting database?" / "Only skip this if you're not
  planning to recruit for Product Management jobs. It's the fastest way to start
  with a real network of PMs, recruiters, and alumni instead of an empty CRM."
  Stay="Keep the database", Leave="Skip it".

## Verification
`npm run test` (1247 pass, incl. new ConfirmDialog test) + `npm run build`.
No migration. Live modal walkthrough needs an authed onboarding session (not
reachable in preview); relying on unit + build.

## Not covered (by design)
Tab-close / hard navigation — beforeunload is hostile + unreliable; only the
in-flow exit buttons are intercepted, per the request.
