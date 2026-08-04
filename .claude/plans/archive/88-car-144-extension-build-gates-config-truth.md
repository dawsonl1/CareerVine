# CAR-144 — Extension build gates & config truth

**Wave 2 · T7 · Straight A's (CAR-28).** Retires findings F14, F33, F57, F32.
Blocked by CAR-138 (CI) — now merged to `main`. Owns `chrome-extension/**`,
`supabase/config.toml`, `chrome-extension/SETUP.md`, plus new CI steps.

## Current-state findings (verified)

- **F14** — panel-app strict tsconfig never runs. `build` is bare `vite build`
  (types-stripped). `tsc --noEmit` passes today only because
  `declare const chrome: any` (App.tsx:35) masks all `chrome.*` typing. The gate
  is meaningless until `@types/chrome` replaces the `any` shim.
- **F33** — committed 212KB `src/content/panel-app/panel.js` can silently drift
  from `panel-app/src`. Empirically, a fresh `npm run build` on this machine
  (Node v26) is **byte-identical** to the committed bundle — determinism holds,
  so rebuild-and-diff (F33's primary approach) is viable. CI will validate
  cross-platform; hash-banner fallback held in reserve.
- **F57** — `background.js:21-26` silently falls back to hardcoded production
  `apiBaseUrl` / `supabaseUrl` / anon key when the env file can't load.
  `popup.js:6` hardcodes `WEBAPP_BASE = 'https://www.careervine.app'`, so in dev
  mode login hits localhost (via background) while signup/reset open production.
  The panel (App.tsx:764-766) is the correct reference: derives webapp base from
  `getConfig` by stripping `/api`.
- **F32** — `supabase/config.toml` exists nowhere (not tracked, not in either
  checkout, never in git history) — the ticket's "commit the real one" premise is
  stale, so we generate a canonical one via `supabase init`. `config.toml.save`
  (stray 2-line editor save) and `.branches/_current_branch` (tracked though
  `.branches/` is now gitignored) are stray artifacts to remove.

## Scope & approach

### 1. Panel-app typecheck (F14)
- `panel-app/package.json`: add `"typecheck": "tsc --noEmit"`; change `"build"`
  to `"tsc --noEmit && vite build"`.
- Add `@types/chrome` to devDependencies; add `"chrome"` to `tsconfig.json`
  `types`; delete `declare const chrome: any` (App.tsx:35).
- Run `tsc --noEmit`; burn down every surfaced error (real Chrome API typing now
  active). Keep explicit `(response: any)` callback params where the message bus
  is genuinely dynamic; do not paper over real type gaps with new `any`.

### 2. Bundle-freshness gate (F33)
- CI job step: `npm ci` + `npm run build` in `panel-app`, then
  `git diff --exit-code -- chrome-extension/src/content/panel-app/panel.js`.
  A stale bundle (src edited, bundle not rebuilt) or a hand-edited bundle both go
  red. Validate against real CI on the PR; if a platform diff appears, fall back
  to embedding a source-tree content hash in the bundle banner and asserting it.

### 3. CI wiring (two steps appended to CAR-138's workflow)
- New `extension` job in `.github/workflows/ci.yml`: checkout → setup-node 22
  (cache `panel-app/package-lock.json`) → `npm ci` → **Typecheck** step
  (`npm run typecheck`) → **Build & verify bundle freshness** step
  (`npm run build` + `git diff --exit-code`).

### 4. Config single-sourcing (F57)
- `background.js`: drop the inline production fallback (21-26). On env-file load
  failure, null the promise (allow retry) and **throw** a clear
  `CareerVine: failed to load packaged env config` error — fail loud, no silent
  prod creds.
- `api.js`: add `getConfig()` wrapping the `getConfig` message → `{ apiBaseUrl,
  environment }`.
- `popup.js`: remove the `WEBAPP_BASE` constant; load webapp base from
  `api.getConfig()` in `init()` (strip `/api`, same as the panel), store on
  `this.webappBase`, and read it at click time in the signup/reset/open-app
  handlers. Console-error loudly if config can't load.
- `popup.css:3`: reword the comment so it no longer embeds the literal domain.

### 5. Config truth (F32)
- Generate canonical `supabase/config.toml` via `supabase init` in a scratch dir
  (CLI 2.109.1); set `project_id`, keep default local ports (API 54321 matches
  `env/development.json`); verify no secrets; commit it.
- `git rm supabase/config.toml.save` and `git rm supabase/.branches/_current_branch`.
- `SETUP.md`: keep `supabase start` (now works from a fresh clone) and add an
  optional `supabase link <project-ref>` step for remote migration pushes.

## Exit-criteria verification

- Introduce a temp panel-app type error → `npm run typecheck` fails (then revert).
- Edit `panel-app/src` without rebuilding → CI bundle-freshness step goes red
  (validated logically + on the PR's real CI run).
- `rg` for the anon key across `chrome-extension/src` → **zero** hits (env only).
  `rg careervine.app` over **hand-written** extension source (background, popup,
  utils, content) → zero. The compiled `panel.js` retains one runtime-fallback
  `careervine.app` from App.tsx:708 — the ticket's blessed panel pattern, out of
  F57 scope; the anon key is absent from the bundle. Revisit only if deep-review
  flags it.
- `git ls-files supabase` → shows `config.toml`, no `config.toml.save`, no
  `.branches/*`. A scratch clone following SETUP.md verbatim reaches `supabase start`.

## Test / verify
- `cd careervine && npm run test` (no careervine source changed, but run to be safe).
- `panel-app`: `npm run typecheck` green, `npm run build` green + byte-identical bundle.
- `build-prod.sh` still succeeds (build now typechecks first).

## Then
Open PR with `(CAR-144)` title → run `/deep-review-pr` on the full PR → fix every
verified finding incl. nits in this PR/ticket → branch merge-ready.
