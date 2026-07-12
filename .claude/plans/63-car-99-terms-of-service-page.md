# CAR-99 — Public Terms of Service page for Google Cloud OAuth verification

## Why

Google Cloud Console OAuth verification (Gmail + Google Calendar consent screen) asks for a Terms of Service URL hosted on the verified domain, next to the Privacy Policy. We ship `/privacy` but have no `/terms`. Need a public, no-auth ToS page at `careervine.app/terms`.

## Constraints / context

- The site's only auth gate for public pages is the **client-side** `SignedOutRedirect` (CAR-64), driven by `isPublicPath()` in `careervine/src/lib/public-routes.ts`. There is **no** server `middleware.ts`. So a page renders its HTML for anyone; the only thing that bounces a signed-out visitor is that client guard. `/terms` must be added to `PUBLIC_PATHS` or Google's reviewer (signed out) gets redirected to `/`.
- Mirror `/privacy` exactly: server component, theme tokens (`bg-background`, `text-foreground`, `text-muted-foreground`, `text-primary`), `max-w-7xl` container, numbered `h2` sections, "Last updated" subtitle. No em dashes in copy (rule 35).
- Branch `dawson/gcp-terms-of-service-page-69673a` lacks a `CAR-` prefix → Linear hooks can't bind → status/plan/PR handled manually.

## Changes

1. **`careervine/src/app/terms/page.tsx`** (new) — Terms of Service. Sections: Acceptance; Description of Service; Eligibility; Accounts & Security; Acceptable Use; Your Content & Data; Third-Party Services & AI; Google & LinkedIn data compliance (points at the Privacy Policy's Limited Use disclosures); Fees (free today, reserves paid features); Intellectual Property; Disclaimers; Limitation of Liability; Termination; Changes; Governing Law (Utah); Contact (dawson@careervine.app). Add a `metadata` export so the browser/tab title is "Terms of Service · CareerVine" (strict improvement over privacy, which inherits the generic title).
2. **`careervine/src/lib/public-routes.ts`** — add `"/terms"` to `PUBLIC_PATHS`.
3. **`careervine/src/components/landing-page.tsx`** — add a `Terms` link next to `Privacy` in the footer.
4. **Tests** — `public-routes.test.ts`: assert `/terms` public and `/terms-of-service` not. `signed-out-redirect.test.tsx`: add `/terms` to the public-paths loop.

## Assumptions to confirm with Dawson

- Governing law = State of Utah, USA.
- Minimum age = 18.
- Service is free; general clause reserves the right to introduce paid features.
- Operator named "CareerVine" (no legal entity invented).

## Verify

- `npm run test` (Vitest) from `careervine/` — all green, new specs included.
- `npm run build` from `careervine/` — route compiles.
- Confirm `/terms` renders content while signed out (client guard leaves it alone).

## Manual step (Dawson, after merge + deploy)

Paste `https://www.careervine.app/terms` into the OAuth consent screen's Terms of Service field in Google Cloud Console.
