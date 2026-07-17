# Dependabot backlog triage — 2026-07-17

14 open Dependabot PRs (#113–127; #124 is a human PR, not Dependabot). Each **major** bump
was build-verified by checking the PR branch out in an isolated scratch worktree and running
the **real CI matrix** for its package (npm ci + the package's typecheck/lint/test/build);
minor/patch groups got diff + changelog review with CI as the green signal. **Nothing was
merged** — these are advisory verdicts. A verdict comment was posted on each PR.

> The ticket estimated "15 Dependabot PRs #113–127"; the actual count is **14** (#124 is
> `dawsonl1`'s InboxShell PR, and #121 `@vitejs/plugin-react` was not named in the ticket's
> grouping). All 14 are triaged below.

## Verdict tally: ✅ 4 SAFE · 🟡 2 NOTE · 🛑 8 HOLD

| PR | Package | Bump | Kind | Verdict | Why |
|----|---------|------|------|:------:|-----|
| [#125](https://github.com/dawsonl1/CareerVine/pull/125) | careervine | @types/node 20→26 | major | ✅ **SAFE** | Full CI-mirror matrix green (tsc/eslint/1708 tests/next build). Type-only, no runtime. |
| [#117](https://github.com/dawsonl1/CareerVine/pull/117) | careervine-mcp | @types/node 20→26 | major | ✅ **SAFE** | mcp typecheck green against @types/node 26. Type-only devDep. |
| [#115](https://github.com/dawsonl1/CareerVine/pull/115) | panel-app | minor-patch group (autoprefixer, postcss) | group | ✅ **SAFE** | Builds clean, committed bundle unchanged. Dev-only build tooling. |
| [#114](https://github.com/dawsonl1/CareerVine/pull/114) | careervine-mcp | tsx 4.23.0→4.23.1 | group | ✅ **SAFE** | Dev-only TS runner patch. Diff is package.json/lock only. |
| [#113](https://github.com/dawsonl1/CareerVine/pull/113) | github-actions | checkout v4→v7, setup-node v4→v7, setup-cli v1→v3 | actions | 🟡 **NOTE** | All legit releases; no fork-PR/token exposure. Glance: setup-cli v3 installs from npm (workflow pins CLI 2.109.1, so unaffected). |
| [#120](https://github.com/dawsonl1/CareerVine/pull/120) | panel-app | lucide-react 0.424→1.24 | major | 🟡 **NOTE** | Builds clean but **committed panel bundle drifts** (panel.js regenerates). CI's bundle-freshness gate fails until someone rebuilds + commits the bundle. |
| [#127](https://github.com/dawsonl1/CareerVine/pull/127) | careervine | typescript 5.9→7.0 | major | 🛑 **HOLD** | `tsc --noEmit` fails: TS7 (native Go rewrite) rejects the `./globals.css` side-effect import (TS2882). |
| [#126](https://github.com/dawsonl1/CareerVine/pull/126) | careervine | eslint 9→10 | major | 🛑 **HOLD** | `eslint . --max-warnings 0` crashes: ESLint 10 removed `context.getFilename()`, which eslint-config-next's bundled eslint-plugin-react still calls (all Next plugins peer-cap at eslint ^9). |
| [#123](https://github.com/dawsonl1/CareerVine/pull/123) | careervine | lucide-react 0.563→1.24 | major | 🛑 **HOLD** | `tsc` fails: lucide-react v1 removed the `Chrome`/`Linkedin` brand icons the app imports in 3 files (trademark removal). |
| [#122](https://github.com/dawsonl1/CareerVine/pull/122) | careervine | minor-patch group (23 updates) | group | 🛑 **HOLD** | `npm ci` ERESOLVE: the group bumps `@modelcontextprotocol/sdk` 1.26→1.29 but `mcp-handler@1.1.0` pins an exact peer on 1.26.0. Other 22 bumps are fine — the SDK must be excluded to land the group. |
| [#121](https://github.com/dawsonl1/CareerVine/pull/121) | panel-app | @vitejs/plugin-react 4→6 | major | 🛑 **HOLD** | `npm ci` ERESOLVE: plugin-react 6 peer-requires vite ^8, panel-app is on vite ^5. Needs a coordinated Vite 8 upgrade. |
| [#119](https://github.com/dawsonl1/CareerVine/pull/119) | panel-app | react + @types/react (major) | major | 🛑 **HOLD** | `npm ci` ERESOLVE: react/@types/react bumped to 19 but react-dom/@types/react-dom left on 18. Needs the DOM packages bumped in lockstep. |
| [#118](https://github.com/dawsonl1/CareerVine/pull/118) | panel-app | typescript 5.9→7.0 | major | 🛑 **HOLD** | `tsc --noEmit` fails (TS5108): TS7 removed `esModuleInterop` + `moduleResolution: node10`, which panel-app's tsconfig sets. |
| [#116](https://github.com/dawsonl1/CareerVine/pull/116) | careervine-mcp | typescript 5.9→7.0 | major | 🛑 **HOLD** | `tsc --noEmit` fails (TS5102): TS7 removed the `baseUrl` option the mcp tsconfig relies on for its `@/*` paths. |

## Recommended morning actions (Dawson)

**Merge the greens** (CI is the final gate — let each PR's checks go green, then merge):
`#125`, `#117`, `#115`, `#114`. Then `#113` after a glance at the setup-cli v3 note.

**One-commit fix, then merge:**
- **`#120`** (panel-app lucide-react) — check out the branch, run `cd chrome-extension/panel-app && npm ci && npm run build`, commit the regenerated `chrome-extension/src/content/panel-app/` bundle, push. Then it goes green.

**Close or convert to tracked upgrade tickets** (each needs real work, not a merge):
- **TypeScript 7** (`#127`, `#118`, `#116`) — TS 7 is the native "Corsa" rewrite that drops legacy compiler options and tightens side-effect imports. This is a project-wide toolchain migration across all three packages, not a dependency bump. Recommend closing these three and filing one "adopt TypeScript 7" ticket.
- **ESLint 10** (`#126`) — blocked on the eslint-config-next / eslint-plugin-react ecosystem supporting ESLint 10. Hold until upstream catches up.
- **lucide-react v1** (`#123`, and the runtime half of `#120`) — v1 removed brand icons (`Chrome`, `Linkedin`). Needs those swapped for a brand-icon package or custom SVGs first.
- **Vite 8 / plugin-react 6** (`#121`) — needs a coordinated Vite 8 major upgrade in panel-app.
- **React 19 in panel-app** (`#119`) — needs react-dom + @types/react-dom bumped to 19 in lockstep (Dependabot split them).

## Dependabot config note

Several HOLDs stem from Dependabot bumping one half of a coupled pair (react without react-dom
in #119; the SDK inside an otherwise-safe group in #122). A `groups`/`ignore` tune-up in
`.github/dependabot.yml` — grouping react with react-dom, and either grouping or ignoring
`@modelcontextprotocol/sdk` until `mcp-handler` widens its peer range — would stop these from
recurring. (CAR-147 already added a "dependabot lockstep group"; extend it.)

## Method / caveats

- Build matrix per package mirrors `.github/workflows/ci.yml`: careervine = npm ci → tsc →
  eslint `--max-warnings 0` → check-ui-events → vitest → next build (with the CI placeholder
  env); careervine-mcp = careervine npm ci + mcp npm ci → mcp typecheck; panel-app = npm ci →
  typecheck → `tsc && vite build` → committed-bundle-freshness check.
- A green build here strongly predicts a green PR because it runs the same commands CI runs.
- Dependabot branches are somewhat behind current `main`; each was built as-is (that is the
  correct "does this bump build" test). A HOLD is a real, reproducible failure of that bump.
- **No PR was merged, and no merge is implied by any comment.**
