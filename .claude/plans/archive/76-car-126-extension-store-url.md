# CAR-126 — Wire live Chrome Web Store URL

## Goal

The CareerVine Chrome extension is published. Point every install CTA at the live listing so users can install it in one click.

**Live listing:** `https://chromewebstore.google.com/detail/careervine-linkedin-integ/jdiefmjeiihacjencfdempbgapnppooj`

(Canonical form without Chrome sidebar UTM params.)

## Changes

1. **Shared constant** `careervine/src/lib/extension-store.ts` — `EXTENSION_STORE_URL` reads `NEXT_PUBLIC_EXTENSION_STORE_URL` with the live listing as fallback (replaces the old placeholder ID `kckdmkjjfcnjlhilgdgfggpgodlmbacd`).
2. **Onboarding modal** — use the shared constant for the "Get the extension from the Chrome Web Store" button.
3. **Getting-started checklist** — use the shared constant so the home-page "Install the Chrome extension" row always opens the store (no longer wait-for-env-only).
4. **Contacts empty state** — turn the "import via Chrome extension" hint into a store link.
5. **Landing page LinkedIn feature** — add an install detail that links to the store.
6. **Docs** (`public/docs/index.html`) — add the store link on the Chrome extension overview and capture section.
7. **README** — mention the live Chrome Web Store listing on the LinkedIn-import bullet.
8. **Vercel** — set `NEXT_PUBLIC_EXTENSION_STORE_URL` to the live URL (Production; Preview/Development too). Redeploy comes with the PR merge to `main`.

## Out of scope

- Closing CAR-40 / CAR-70 (demo clips, remaining launch checklist items).
- Rebundling or republishing the extension itself.
