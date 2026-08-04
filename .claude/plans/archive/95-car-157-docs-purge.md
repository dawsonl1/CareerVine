# CAR-157 — Kill the false map: pointer-style conventions doc + docs-reality purge

Wave 6 of the Straight A's program (CAR-28). Retires F16, F17, F40, F41, F60.
Blockers CAR-146, CAR-151, CAR-155 are all Done, so the structural reality this
documents has landed.

## Ground truth established first

Six read-only verification agents swept the codebase before any prose was
written. Every claim below is cited. Three of the ticket's own descriptions
turned out to be wrong, and the doc follows the code, not the ticket:

| Ticket says | Reality |
| --- | --- |
| "contact-write module" | No such module. The chokepoint is `canonicalizeContactPayload()` inside `careervine/src/lib/data/contacts.ts:231`. The standalone canonicalization module is `data/locations.ts`. |
| "sendingRef guard" | No such identifier anywhere. The real double-submit guards are `submittingRef` / `savingRef`, hand-rolled `useRef(false)` at 6 sites. |
| `capabilities/types.ts:2-7` | Real path `careervine/src/lib/capabilities/types.ts`; the rule is at `:4-6`. 7 capability keys, not the 5 the old plan doc lists. |

Also corrected in passing: `src/mcp/lib/db.ts` is 1,140 lines (its header's "thin
layer" means "not a fork", not "small"), and `ui/modal.tsx` has **no** focus trap.

## 1. Conventions doc (F16, F17)

Delete `careervine/ARCHITECTURE.md`. Its substance dates to 2026-02-14 and it is
a comprehensive map, which the judge explicitly ruled against rebuilding. Replace
with `careervine/CONVENTIONS.md`: eight sections, 3-6 lines each, every one
ending in a pointer to the authoritative code header rather than restating it.

All cited paths are **repo-root-relative** (`careervine/src/...`), one rule, no
ambiguity. Sections and their authorities:

| § | Topic | Authority |
| --- | --- | --- |
| a | API routes: `withApiHandler`, `api-schemas.ts`, `{error, code?}` envelope, `{success: true}`, curated errors | `careervine/src/lib/api-handler.ts:1-29` |
| b | Cron/queue: verify-outside-guard nesting, schedules declared only in the registry | `careervine/src/lib/qstash-verify.ts:1-16`, `careervine/src/lib/cron-guard.ts:4-9` |
| c | Capability-only gating (CAR-103) | `careervine/src/lib/capabilities/types.ts:1-7` |
| d | Data layer: `db()`, frozen barrel, `must()`, rules modules, MCP scoping | `careervine/src/lib/queries.ts:1-17`, `careervine/src/lib/data/client.ts:37-47`, `careervine/src/mcp/lib/db.ts:1-13` |
| e | `sendAppEmail` vs `sendTrackedEmail` | `careervine/src/lib/notify/email.ts:1-10`, `careervine/src/lib/email-send.ts:1-23` |
| f | Client state: ui-events, `useLatestRequest`, optimistic-with-rollback, double-submit refs, `ui/modal.tsx` | `careervine/src/lib/ui-events.ts:1-14`, `careervine/src/hooks/use-latest-request.ts:3-26` |
| g | Bespoke-auth allowlist, `BUNDLE_ADMIN_TOKEN`, cross-package tsconfig edges | `careervine/src/__tests__/route-auth-inventory.test.ts:36-57`, `careervine/src/lib/admin-auth.ts:32-39` |
| h | New tests use the shared harness helpers | `careervine/src/__tests__/helpers/`, `careervine/vitest.config.ts` |

**Honesty requirement:** only two of these conventions have mechanical
enforcement (the ui-events CI guard and the CAR-151 eslint fences). The doc says
plainly which rules are enforced and which are convention-by-review. It also
records that `ui/modal.tsx` adoption is aspirational (10 adopters vs 9
hand-rolled dialogs) rather than implying it is universal. A doc that overstates
its own authority is the failure mode this ticket exists to fix.

New test `careervine/src/__tests__/conventions-doc.test.ts`: parses every
backticked repo-relative path out of the doc, asserts each exists on disk, and
asserts the doc mentions `withApiHandler`. Resolves the repo root from
`import.meta.url`, not `process.cwd()`, so it is invocation-independent. Runs in
CI via the existing `web` job.

Link the doc from `CLAUDE.md`.

## 2. Quarantine stale docs (F40)

- Move `careervine/GOOGLE_CALENDAR_PLAN.md` (39 KB, untouched since 2026-02-18)
  to `.claude/plans/` with a first-line `HISTORICAL - superseded, do not trust`
  banner.
- Stamp `docs/superpowers/specs/2026-03-25-onboarding-flow-design.md` as
  superseded by `20260708000000_drop_onboarding.sql` and CAR-50; stamp the
  intro-email spec likewise.
- Delete `future_tasks.md` (untouched since 2026-02-17).
- Prune `future_ideas.md` of claims the code has since falsified.

## 3. Counts and cadence (F41)

Root README hand counts are all wrong: **468 tests** (actual 229 files /
~1,974 cases), **61 API routes** (actual 105), **38 migrations** (actual 98).
Remove the counts rather than correcting them, since a hand-maintained count is
guaranteed to rot.

`careervine/README.md` loses its create-next-app boilerplate for a short
dev-setup section.

Cadence: `send-follow-ups` is `*/10` (every 10 min), not 15. The stale claim
appears in **three** places, one more than the ticket lists:
`careervine/README.md:29`, `careervine/public/docs/index.html:729` (prose **and**
the `Every 15 min` tag), and `careervine/src/app/api/cron/send-follow-ups/route.ts:20`.
The docs line also wrongly describes one worker doing two jobs that are actually
two schedules on different cadences, so it needs a rewrite, not a number swap.
User-facing copy stays em-dash-free (rule 35).

**Durable fix, not just a copy edit:** `cron-schedules-registry.test.ts` today
asserts route/entry correspondence but pins **no cron expression**, so cadence
can silently drift again. Extend it to pin every cron expression and to assert
the follow-up cadence claimed in `README.md` and `public/docs/index.html` matches
the registry. That is what stops F41 from recurring.

Amend the Workflows docs rule so a `qstash-schedules.mjs` change triggers a
docs-page copy check.

## 4. Plan naming (F60)

`CLAUDE.md`'s "highest existing number + 1" rule races: **32 of 150** plan files
share a duplicated `NN` prefix (three `90-*`, two each of `93-*`/`94-*`, and 29
more). The hook does not care: `_ln_parse_ref` extracts `CAR-XX` from the
filename and ignores the prefix entirely. Amend the section so the Linear ticket
is the unique key and `NN` is an optional ordering hint. Do not renumber
existing files.

## 5. In-code doc defects found en route (rule 44)

Fixed in the same pass rather than reported back:

- `careervine/src/app/api/extension/ping/route.ts:3` documents `{ok: true}`; the
  code returns `{success: true}`.
- `careervine/src/app/api/cron/send-follow-ups/route.ts:20` says "every 15
  minutes" against an actual `*/10`.
- `careervine/scripts/check-ui-events.mjs:50` prints a stale exemption notice for
  a file CAR-150 already converted.

## Verification

- `npm run test` and `npx tsc --noEmit` green from `careervine/`.
- Pointer test goes red when a cited path is renamed (verified by temporarily
  breaking one).
- Cadence test goes red when a cron expression changes (verified the same way).
- `rg withApiHandler --glob '*.md'` hits the new doc.
- Every claim in the doc traced to a cited file before merge.
