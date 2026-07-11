# CAR-64 — Redirect signed-out users to the landing page instead of stranding them

## Problem

Sign out in tab A (global scope — clears the shared auth cookies), then refresh tab B
sitting on any app page (`/contacts`, `/meetings`, …): tab B re-mounts, `AuthProvider`
finds no session, `Navigation` self-erases (`if (!user) return null`), and the page
renders a dead shell — no navbar, no data, no way to navigate. The only recovery is
manually editing the URL back to `/`.

## Root cause

There is **no unauthenticated redirect anywhere except the root page**:

- No `middleware.ts` — a refresh of any URL is served straight to the client page.
- `auth-provider.tsx`'s `onAuthStateChange` only syncs state; no `SIGNED_OUT` redirect.
- Only `src/app/page.tsx` falls back to `<LandingPage />` when `user` is null. Every
  other route unconditionally renders its authenticated shell; the navbar hides itself
  and the data callbacks early-return, producing the stranded page.

## Fix

Client-side route guard, mounted once in the root layout inside `AuthProvider`:

1. **`careervine/src/lib/public-routes.ts`** — `isPublicPath(pathname)` with an
   explicit allowlist. Public: `/` (landing renders there), `/privacy`,
   `/reset-password`, `/contacts/preview` (extension flow, has inline `AuthForm`),
   and the `/auth/*` + `/oauth/*` prefixes (`/oauth/consent` has its own inline
   sign-in for the MCP OAuth flow — redirecting would break it). Prefix matching is
   segment-aware (`/auth` matches, `/authors` doesn't). Everything else is protected.
2. **`careervine/src/components/signed-out-redirect.tsx`** — small `"use client"`
   wrapper: when `!loading && !user && !isPublicPath(pathname)`, call
   `hardNavigate("/")` and render `null` (no dead-shell flash while navigating).
   Otherwise render children.
3. **`careervine/src/app/layout.tsx`** — wrap the provider tree's children in
   `<SignedOutRedirect>`.

Because the guard is reactive to auth state (not just mount), it also covers the
live case: if Supabase broadcasts `SIGNED_OUT` to the other tab, it redirects
immediately, without waiting for a refresh. `hardNavigate` (not `router.replace`)
matches the existing sign-out pattern — a full page load guarantees all in-memory
state from the dead session is discarded.

### Considered and rejected

- **`middleware.ts` with Supabase session check** — the canonical server-side
  answer, but all pages here are client components fetching data client-side under
  RLS; middleware adds no data protection, costs latency on every request, and
  risks the MCP OAuth surface (`/.well-known/*`, `/api/mcp`, `/oauth/consent`).
  The stranded tab is a client UX bug; the client guard fixes it where it lives.
- **Per-page `if (!user)` guards** — 12+ pages to patch and every future page is a
  foot-gun. One guard in the root layout covers all current and future routes.

## Tests

- `src/__tests__/public-routes.test.ts` — allowlist behavior: public paths, protected
  paths, prefix-boundary cases (`/authors`), nested protected routes.
- `src/__tests__/signed-out-redirect.test.tsx` (jsdom) — mocks `useAuth`,
  `usePathname`, `hardNavigate`: renders children while loading; renders children
  when signed in; redirects + renders null when signed out on a protected path;
  does not redirect on public paths.

## Verification

`npm run test` and `npm run build` from `careervine/`.
