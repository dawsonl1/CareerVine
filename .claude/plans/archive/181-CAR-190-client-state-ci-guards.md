# CAR-190: CI guards for the client-state conventions

Adds the client-state checks to `careervine/scripts/check-conventions.mjs`, fixes the
four live defects the ticket's audit-corrections comment named, hardens check (f), and
repairs two undercounts in the docs.

## Preconditions verified

- **CAR-188** (blocker) is Done, PR #179 merged. The tree is genuinely clean: zero raw
  `fetch(` and zero `window.confirm` under `src/components`, `src/hooks`, `src/app`
  outside `src/app/api`. Guards 1 and 2 can ship as hard failures, not warnings.
- **CAR-187** (conflicts on the same script) is Done, PR #171 merged. No concurrency risk.
- Branch is at `origin/main` (76a1050) with nothing behind.

## Rollout model: named baseline ratchets, not warnings

The ticket suggests shipping guards 3 and 4 as "a warning that lists offenders". A
warning does not fail CI, so it is not a guard, and unenforced conventions decaying is
the exact failure this ticket exists to stop (CAR-154 decayed to 6 files, CAR-158 to 1).

The house already has the right pattern in this same file: check (d)'s ratchet, whose
own comment argues "the number can only go DOWN". Guards 3, 4 and 5 use a **named**
baseline (an explicit `file::handler` list in the script) rather than a count, because a
count lets a fixed violation be traded for a new one silently. Contract:

- an offender **not** on the list → hard CI failure (new code cannot regress);
- a list entry that no longer offends → hard CI failure telling you to delete the line
  (a fixed site can never be given back).

Measured today against the real tree, after the four defect fixes below:

| Guard | Trigger | Baseline |
| -- | -- | -- |
| 1. raw `fetch(` | identifier / `window.` / `globalThis.` call | **0** (hard) |
| 2. `window.confirm` / global `confirm(` | not locally bound (the `useConfirm()` sites bind it) | **0** (hard) |
| 3. double-submit ref | async `handle*`/`on*` awaiting a **mutating** seam | 35 |
| 4. `useLatestRequest` | identity-keyed dep + `setState` derived from the await | 8 |
| 5. dialog semantics | `fixed inset-0` outside `modal.tsx` without `role="dialog"` anywhere in its subtree | 12 |

Guard 3's trigger requires a *mutating* seam (`apiSend`, `withToastOnError`, or a
`@/lib/data` import whose name starts with a mutation verb), not any seam. Untightened it
flags 51 sites, most of them reads; tightened it flags 42, of which 7 already comply.

Guard 5 is the fifth guard the audit comment asked us to consider. Its 12 baseline
entries are exactly CAR-197's migration list, so that ticket drains this baseline to
zero as it lands.

Two calibration corrections found by running the detectors against the real tree, both
kept because they are the difference between a guard and a nuisance:

- Guard 3 must accept CAR-204's **per-identity** guard shape (`cancellingRef.current.add(id)`),
  not only `submittingRef.current = true`. The first version reported
  `handleScheduledEmailCancel` as unguarded when it is the best-guarded handler in its file.
- Guard 5 must look for the role **anywhere in the overlay's subtree**. `modal.tsx` and
  `confirm-dialog.tsx` both put the scrim and centring on the fixed div and `role` on the
  panel inside it, so asking only the fixed element reported the two best dialogs in the
  app as violations.

## Live defects fixed here (the audit's inventory pass)

All four re-verified against current `main` before writing this plan.

1. **`src/app/outreach/page.tsx:99`** (HIGH). `loadDetail` has no token, no cancelled
   flag, no abort. Two `getCompanyDetail` calls race on arrow-key/Select navigation and
   the slower wins last, rendering company B's header over company A's employees;
   clicking a person there opens a prefilled compose to the wrong company. Separately
   `detail` is never cleared on company change and the gate is `detailLoading && !detail`,
   so the previous company's people render under the new header for the whole fetch on
   every navigation after the first. Needs `useLatestRequest` **and** clearing `detail`.
2. **`src/hooks/use-gmail-connection.ts:93`**. `refresh()` nulls `fetchPromise` before
   fetching, so the onboarding 3s poll can have two requests live against one shared
   store with no sequence number; a stale `connection: null` can land last and flip the
   app back to "Connect Gmail". Fix with a monotonic request id in the module store.
3. **`src/components/home/today-schedule.tsx:410`** (MEDIUM, creates real Google Calendar
   events). The title input's `onKeyDown` calls `void handleSave()` on every Enter with
   no `saving` and no `e.repeat` check, and `/api/calendar/create-event` has no
   idempotency key, so each press creates a distinct Google event and Meet link.
4. **`src/components/home/unified-action-list.tsx:174`**. `NotePopover.handleSave`, same
   shape, guarded only by `disabled`, which is async state.

## Also in scope

- **Harden check (f)** (`check-conventions.mjs:509`). It accepts a `vi.mock` whose factory
  *text* merely contains the helper name, so a comment or string satisfies it. Match a
  real `CallExpression` to the factory identifier, strip comments (check (e) in the same
  file already does), and cover `vi.doMock`. Latent, not live: there are zero `vi.doMock`
  calls and zero relative module mocks today.
- **Fix two undercounts.** The script carries **seven** checks (its banner labels them
  (a)-(f), but (a) is two separate reports). `CONVENTIONS.md` §d says "four"; the ticket
  description says "four". Correct both.
- **Rewrite `CONVENTIONS.md` §f enforcement.** Four of its five client-state rules
  currently say "not enforced"; say what enforces them and where. `conventions-doc.test.ts`
  asserts every cited path exists.

## Files

- `careervine/scripts/check-conventions.mjs` (five new checks + check (f) hardening)
- `careervine/src/__tests__/check-conventions.test.ts` (red case + clean control per guard)
- `careervine/CONVENTIONS.md` (§d count, §f enforcement)
- the four defect sites above, plus tests for each

## Verify

1. `npm run check:conventions` from `careervine/` exits 0 on the clean tree.
2. Prove each of the five guards bites: reintroduce one violation of each and confirm a
   non-zero exit naming the file and line. This runs as unit tests against a temp fixture
   tree, matching the existing harness in `check-conventions.test.ts`.
3. Prove the ratchets bite in both directions: an unlisted offender fails, and a listed
   site that no longer offends fails with "delete this line".
4. `npm run test`, `npm run lint`, `npm run build` from `careervine/`.
5. Falsification pass: patch each defect fix back out and confirm the matching test goes
   red.
