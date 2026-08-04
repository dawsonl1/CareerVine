# CAR-138 — Stand up the P0 CI gate

Wave 1 · T1 of the Straight A's program (CAR-28). Retires F2, F13, F58. This is the
enforcement floor every later remediation wave depends on: the repo auto-deploys
`main` via Vercel with zero CI, and local baselines are red so agents can't attribute
red output to their own change.

## Verified baseline (2026-07-17)

- `npx tsc --noEmit` (careervine): **25 errors, all in `src/__tests__/`** (vi.fn mock typing +
  tuple-spread patterns). App/source code is clean.
- `npx eslint . --max-warnings 0`: **205 errors + 70 warnings**, breakdown:
  - `@typescript-eslint/no-explicit-any` — 172 err, across 40 files → **suppress with per-site
    inventory comments → CAR-142** (root cause = untyped Supabase clients, dies there).
  - `@typescript-eslint/no-unused-vars` — 63 warn, 33 files → **remove/underscore**.
  - react-hooks (set-state-in-effect 10, refs 6, purity 4, globals 3, immutability 1,
    preserve-manual-memoization 1, exhaustive-deps 5w) → **individually fix, don't blanket-suppress**.
    5 are in test files (globals×3, refs×2) → scope the compiler rules off for the test glob (they
    don't apply to test harnesses); the ~24 production ones get real fixes.
  - trivial: no-unescaped-entities 3, no-empty-object-type 3, prefer-const 2, no-img-element 1w,
    one stale eslint-disable directive (transcript-uploader).
- careervine-mcp `npm run typecheck`: **already exits 0**.
- `main` has **no branch protection** (404).

## Plan

### 1. Scaffolding
- `.github/workflows/ci.yml`, triggers `pull_request` + `push` to `main`, Node 22, npm cache
  keyed on both lockfiles. Two jobs:
  - `web` (from `careervine/`): `npm ci` → `npx tsc --noEmit` → `npx eslint . --max-warnings 0`
    → `npx vitest run` → `npx next build` (build step gets placeholder NEXT_PUBLIC_* env).
  - `mcp` (from `careervine-mcp/`): `npm ci` → `npm run typecheck`.
  - No `continue-on-error` (burn-down completes in this ticket, so checks are green from the start).
- `careervine/package.json`: add `"typecheck": "tsc --noEmit"`, add `"test:coverage": "vitest run
  --coverage"`, **delete** the vestigial `"pretest": "npm install --prefix ../careervine-mcp ..."`
  (F58 — vitest only includes `src/**`, the install serves nothing and touches network).
- Add `@vitest/coverage-v8@^4` devDep (report-only, no threshold gate).
- `eslint.config.mjs`: add a test-glob override turning off the React-Compiler static rules
  (`react-hooks/{globals,refs,set-state-in-effect,purity,immutability,preserve-manual-memoization}`)
  for `**/*.test.ts(x)` + `__tests__/**` — those target shipped components, not test code.

### 2. tsc burn-down (25 errors, all tests)
Type the `vi.fn()` mocks to their real signatures, fix tuple-spread call patterns
(`sync-bundles-cron.test.ts:15/20`, etc.), supply the missing required properties on mock rows
(`path` on ApplyStepResult, `current_position` on CompanyPerson, etc.). Source of truth = the real
types the mocks stand in for. No production code changes.

### 3. eslint burn-down
- Trivial fixes: escape entities, replace `interface X extends Y {}` empty-object-types with type
  aliases, `let`→`const`, drop the stale disable directive, address the one `<img>` warning.
- react-hooks (production, ~24) — fix per idiom, behavior-preserving:
  - `purity` (confetti-burst Math.random in useMemo) → generate pieces in a mount effect into state.
  - `immutability` (network-donut `let offset` accumulator) → functional cumulative sum, no reassign.
  - `refs` (cursor-tooltip consumers reading `posRef.current` during render) → seed initial tooltip
    position from the enter-event / layout effect instead of reading the ref in render.
  - `set-state-in-effect` (~10) → derive-during-render / lazy-init / guard, case by case.
  - `exhaustive-deps` (warns) → add/remove the flagged dep honestly.
  - Browser-verify the high-risk UI surfaces touched (home dashboard, onboarding modals, pickers).
- `no-unused-vars` — remove unused imports/vars; underscore genuinely-unused params.
- `no-explicit-any` (172) — LAST, computed from a fresh eslint run: insert per-site
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: untyped Supabase
  boundary; remove when typed`. Per-site (not config-blanket) keeps the gate live for NEW `any`s in
  every other file. Verify no JSX-context breakage via tsc/build.

### 4. Enforce
- Branch protection on `dawsonl1/CareerVine` `main` via `gh api`: required checks `["web","mcp"]`,
  `enforce_admins: false` (rule-14 direct-commit path survives), no required reviews.
- Exit-criteria proof: open a throwaway PR with a failing test and one with a broken type (branches
  WITHOUT a CAR id so Linear doesn't bind) → confirm each goes red and merge is blocked → close.

## Exit criteria (from ticket)
- Failing-test PR and broken-type PR each red + unmergeable; `gh api .../branches/main/protection`
  shows required checks.
- Clean `main`: `tsc` exits 0, `eslint . --max-warnings 0` exits 0, `ci.yml` has no `continue-on-error`.
- `grep pretest careervine/package.json` empty; `npm run test` touches no network.
