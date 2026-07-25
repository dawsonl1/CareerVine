# CAR-186 — Coverage thresholds for `src/lib` so logic regressions cannot land uncovered

Wave 1 of CAR-182. `@vitest/coverage-v8` was installed and `npm run test:coverage`
existed, but `careervine/vitest.config.ts` declared no coverage config and no
thresholds, so coverage was a number nobody looked at and nothing could fail on.

## What research changed about the approach

The ticket specified percentage floors "a couple of points below current". I built
that, then measured whether it actually solves the stated problem — *"a new module
in `src/lib` can land with zero tests and CI stays green"*. It does not.

Dropping a 200-statement untested module into `src/lib` moves the global figure to
66.76 / 60.57 / 63.46 / 69.85. Every one of those clears a floor set two points
under baseline. **A percentage-only gate ships green on the exact regression the
ticket was written to stop.** The corpus is 8,310 statements; no single module is
big enough to move the ratio past a sane buffer.

So the config carries two instruments:

1. **Global percentage floors** (66 / 59 / 63 / 69) — the anti-erosion backstop.
   Catches broad decay: tests deleted, a suite disabled, a refactor that guts
   assertions.
2. **Per-area uncovered-code budgets** — Vitest's negative-threshold form, where
   `-N` means "at most N uncovered units". Catches *new untested code* regardless
   of corpus size. Split `src/lib` / `src/hooks` so a weak area cannot hide behind
   a strong one: hooks sit at 25% statements, and blending that into one global
   number buries it.

Headroom is ~3% of each area's uncovered total, calibrated to pass a well-tested
feature (200 new statements at 85% adds ~30 uncovered) and fail an untested one
(200 new statements adds 200).

## Measured baseline

`npm run test:coverage`, 249 files / 2,359 tests / 165 source files.

| Area | stmt | brch | func | line |
| -- | -- | -- | -- | -- |
| global | 68.37% | 61.31% | 65.41% | 71.43% |
| `src/lib` | 70.62% (2321 unc.) | 62.49% (2427) | 68.09% (382) | 73.83% (1760) |
| `src/hooks` | 24.94% (307) | 16.57% (141) | 35.51% (69) | 25.78% (262) |

Verified properties before trusting the numbers:

- **Node parity.** Identical output on Node 22 (CI) and Node 26 (local). No V8
  version drift, so a locally-set threshold is valid in CI.
- **Determinism.** Byte-stable across four runs for statements, functions and
  lines. `branches` drifts ±1, so no threshold sits within 1 of it.
- **Wall clock.** On CI's Node 22, clean sequential runs: 17.25s / 18.09s with
  coverage vs 19.70s / 17.34s without. The overhead is inside run-to-run noise,
  not the 30-50% the ticket anticipated — the v8 provider reads V8's built-in
  counters rather than instrumenting a second build.

## Scope decisions

- **`src/components` and `src/app` stay unmeasured**, per the ticket. A line number
  on UI files rewards render-and-assert-nothing tests. CAR-189's E2E tier owns them.
- **`constants.ts` is NOT excluded.** The ticket said to exclude it "if it is pure
  data"; measured at 97.82%, so it is well-covered real code and keeping it helps.
- **Only `database.types.ts` is excluded** (generated, pinned by the types-drift
  job) plus test files. No module was excluded to flatter a number: every
  zero-coverage file was read, and all are genuinely testable rather than
  structurally uncoverable.

## Files

- `careervine/vitest.config.ts` — coverage block, thresholds, measured baseline
  recorded in a comment
- `.github/workflows/ci.yml` — `web` job test step to `npx vitest run --coverage`
- `careervine/src/__tests__/priority-helpers.test.ts` — new
- `careervine/src/__tests__/nav-history.test.ts` — new
- `careervine/src/lib/priority-helpers.ts` — prototype-chain bug found by the new test
- `careervine/CONVENTIONS.md` — §h records the gate

## Bug found and fixed in passing

`getPriorityOrder` indexed a plain object literal and fell back with `??`. Because
the lookup walks the prototype chain, `getPriorityOrder("constructor")` returned
the `Object` constructor — a function from a signature typed `: number`, which
would feed NaN into `sortByPriorityThenDate`'s comparator and destabilize the sort.
Latent rather than live (the DB constrains the column), fixed with `Object.hasOwn`.

## Verification

- `npm run test:coverage` → exit 0, gate green.
- **Negative test, new untested module:** 200-statement probe module added to
  `src/lib` → exit 1, all four `src/lib` budgets fire, all four percentage floors
  stay green. This is the empirical proof the budget layer is load-bearing.
- **Negative test, deleted tests:** seven large suites removed from collection →
  exit 1, all four percentage floors fire *and* all four budgets fire.
- `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, ui-events guard, conventions
  guard: all clean. No `.next/` in this worktree, so lint and typecheck ran under
  the same cold conditions as CI (rule 48).

## Known gap, deliberately left

`src/hooks` at 25% statements is the weakest tier in the repo, and its floor is set
at that measured level so it can only improve. Testing those nine hooks properly is
a distinct piece of work and would balloon this PR well past its stated scope; the
budget means new untested hook code fails immediately in the meantime.
