# CAR-45 — Sign out doesn't redirect to the landing page

## Problem

Clicking **Sign out** clears the Supabase session but never navigates. On `/` the auth listener happens to swap in `LandingPage`, but from any other page (`/contacts`, `/settings`, `/calendar`, …) the user is stranded on an empty authenticated shell — pages guard with `if (!user) return;` in their data loaders and never redirect.

## Root cause

`signOut` in `careervine/src/components/auth-provider.tsx`:

```ts
const signOut = async () => {
  await supabase.auth.signOut();
};
```

No navigation. `SignOutButton` (the only caller) relies on it entirely.

## Fix

In `auth-provider.tsx`, after signing out, hard-navigate to `/`:

```ts
const signOut = async () => {
  try {
    await supabase.auth.signOut();
  } finally {
    window.location.assign("/");
  }
};
```

- **Hard navigation** (not `router.push`) so every in-memory context (compose, quick capture, SWR-style caches) resets cleanly — the user gets a fresh landing page.
- **`finally`** so the redirect happens even if the network revocation call fails — supabase-js clears the local session regardless, so the user is signed out locally either way.
- Fix lives in the provider so any future caller of `signOut` gets the redirect too.

## Tests

Extend the auth-provider/sign-out test coverage: signing out calls `supabase.auth.signOut()` and navigates to `/`, including when `signOut` rejects. Run `npm run test` from `careervine/`.

## Scope

Single file (`auth-provider.tsx`) + tests. No schema, no env, no new domain.
