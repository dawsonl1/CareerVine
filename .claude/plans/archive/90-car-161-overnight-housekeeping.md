# CAR-161 — Overnight autonomous housekeeping

Off-plan hygiene work, unattended single-session run. Read-only audits + Dependabot
triage + safe cold-file fixes. **No self-merge, no hot-file edits, nothing on the
Straight A's critical path (CAR-138..159).**

## Guardrails (binding)

1. Never `gh pr merge` any PR. Open/push/comment only.
2. Never edit hot files/trees (queries/company-queries/pipeline-queries/api-handler/
   rate-limit/api-schemas/gmail/calendar/email-send.ts, `src/lib/data/**`, `src/lib/rules/**`,
   `src/mcp/**`, `components/email/inbox/**`, compose-email-modal, contact-edit-modal,
   contact-info-header, `app/{page.tsx,meetings,contacts,calendar}/**`, both READMEs,
   ARCHITECTURE.md). For anything to change there → write a recommendation into the report.
3. Cold zone (trivial obviously-correct fixes only): `public/docs/index.html`,
   `app/{auth,privacy,terms,reset-password,oauth}/**`, and any NEW files. Anything needing
   judgment → report, don't apply.
4. No migrations/schema/secrets/`supabase db push`/external sends/dep-version changes
   (except Task 7 which only reads dependabot branches, never merges).
5. CI (web/mcp/extension required; types-drift too) must be green before marking ready.
   Baseline on main is currently GREEN (8ff2ff2).

## Execution model

Main loop owns the git spine (commits per task, draft PR after Task 1, PR/Linear comments,
final CI verify, ready-for-review). Two background Workflows do the heavy parallel analysis:

- **Audit workflow** — 6 read-only agents (coverage, vulns, dead-code, a11y, copy, perf).
  Each WRITES only its own new report file under `careervine/docs/audit-reports/2026-07-17/`
  and returns a structured summary; a11y+copy also return a vetted list of proposed
  cold-zone edits which the main loop applies after review + web checks.
- **Dependabot workflow** — one agent per open PR (#113–127 minus #124). Major bumps get a
  scratch-worktree build matrix (`npm ci` + package-appropriate typecheck/test/build);
  minor/patch groups get diff+changelog review with CI as the green signal. Returns a
  verdict per PR. Main loop posts SAFE/NOTE/HOLD comments and writes the triage table.
  Heavy builds run in bounded batches to protect the machine overnight.

## Tasks (each ends in a commit; PR stays pushed for resumability)

- **0** Setup: this plan, `docs/audit-reports/2026-07-17/` + INDEX.md skeleton.
- **1** `coverage-gaps.md` (vitest --coverage, risk-ranked) → open draft PR.
- **2** `dependency-vulns.md` (npm audit --json ×3 packages).
- **3** `dead-code-inventory.md` (knip; safe-to-remove vs defer; no deletions).
- **4** `accessibility-audit.md` + trivial cold-zone a11y fixes.
- **5** `copy-sweep.md` + trivial cold-zone copy fixes (rule 35: no em dashes in rendered copy).
- **6** `public-pages-perf.md` (static analysis of public/docs surface).
- **7** `dependabot-triage.md` + verdict comment on all 14 PRs. Never merge.
- **8** Finalize INDEX.md, push, verify CI green, mark PR ready, post `<!-- progress -->` on CAR-161.

## CI facts (for cold-zone edits + dependabot matrix)

- `web`: npm ci → tsc --noEmit → eslint . --max-warnings 0 → check-ui-events → vitest → next build.
- `mcp`: careervine `npm ci` + mcp `npm ci` → mcp `tsc --noEmit` (mcp resolves out of ../careervine).
- `extension`: panel-app npm ci → typecheck → `tsc && vite build` → committed-bundle freshness.
- `types-drift`: supabase regen (only touched by migration PRs).
- Report `.md` files under `careervine/docs/` are not linted/typechecked/built. `public/docs/index.html`
  is static (safest cold target). Auth/legal `.tsx` edits DO go through tsc+eslint → verify locally.
