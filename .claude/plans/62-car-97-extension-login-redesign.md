# CAR-97 — Redesign extension login screens + post-login popup

## Problem

The Chrome extension has **two** sign-in screens (the toolbar **popup** and the LinkedIn **panel**) that have drifted apart from each other and from the polished web app auth (`careervine.app/auth`). The post-login popup view is utilitarian, uses the wrong (shield) logo, and shows a coded-but-never-rendered avatar.

## Design target (decided with Dawson)

Mirror the web app's `AuthForm` (`careervine/src/components/auth-form.tsx`) so web ↔ extension feel like one product. Shared spec both surfaces converge on:

- **Brand lockup:** Sprout icon (green `#2d6a30`) + "CareerVine" wordmark, top-left; larger centered Sprout above the card on the narrow layout.
- **Copy:** heading "Welcome back", subheading "Sign in to CareerVine".
- **Card:** outlined (1px `--md-outline-variant`), white, radius 16px, generous padding.
- **Inputs:** ~52–56px tall, left-aligned Mail/Lock icon, 4px inner radius, focus = 2px primary border, 16px text (prevents iOS zoom / feels substantial).
- **Password:** show/hide eye toggle.
- **Button:** full-width, filled primary, radius 20px, subtle shadow, **loading spinner** on submit.
- **Error:** `error-container` banner (soft red), not the ad-hoc pink box.
- **Footer:** "New to CareerVine? Create an account" + "Forgot password?" (both deep-link to `careervine.app/auth?mode=…`, opened in a new tab).
- **Type:** system font stack on both (drop the CSP-fragile Google Fonts `@import` inside LinkedIn). Brand cohesion carried by logo + color + layout + copy.

## Post-login popup (toolbar) — smart, action-first

Replaces the Import/Recent tabs with one focused view:

1. **Signed-in header** — Sprout + wordmark, and a real avatar/initial (fix: currently never renders) + the user's email/name.
2. **Context-aware current-page card:**
   - On a LinkedIn profile (`linkedin.com/in/...`) → prominent **"Import this profile"** primary action (opens the profile's panel / triggers the import path the panel uses).
   - Elsewhere → gentle guidance: "Open any LinkedIn profile, then click Import."
3. **Recent imports** — compact list (reuses `storage.getRecentContacts()`), clean empty state.
4. **Open CareerVine** — link/button to `careervine.app`.
5. **Sign out** — quiet, in a footer.

## Files

**Popup (vanilla, no build) — `chrome-extension/src/popup/`:**
- `popup.html` — replace shield with Sprout SVG; restructure auth card + post-login view.
- `popup.css` — align tokens/spacing to web app; system font; input icons; eye toggle; button radius 20px + spinner; error-container banner; new post-login card styles.
- `popup.js` — render avatar/initial + email in header (fix); wire "Import this profile" CTA off `getCurrentTabInfo`; eye toggle; submit spinner; remove tab switching.

**Panel (React/Vite) — `chrome-extension/panel-app/`:**
- `src/App.tsx` — rebuild the `!isAuthenticated` block to the shared spec (Sprout, card, icon inputs, eye toggle, spinner, error-container). Add `Sprout, Mail, Lock, Eye, EyeOff` from `lucide-react` (already a dep). Add submit loading state.
- `src/styles.css` — remove Google Fonts `@import`; system font stack; rewrite `.cv-login-*` to match; error-container styles.
- Build: `npm install` then `npm run build` (outputs `../src/content/panel-app/panel.js`). Needs node_modules (fresh worktree).

## Verification

- Load unpacked extension in the in-app browser; screenshot popup login, popup post-login (both on-a-profile and not), and the panel login on a LinkedIn profile.
- Confirm: identical look across popup ↔ panel ↔ web app; Sprout everywhere; eye toggle works; submit shows spinner; no console errors; no Google Fonts request from the panel.
- `npm run build` clean; no TS errors.

## Out of scope

- Auth logic / endpoints (unchanged — visual + IA only).
- Dark mode (extension is light-only).
- Web app auth page (already the reference).
