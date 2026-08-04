# CAR-162 — Fix non-breaking dependency vulnerabilities

Top follow-up from the CAR-161 audit (`dependency-vulns.md`). Clear the **non-breaking**
`npm audit` advisories that ship to users. Pure dependency hygiene, no product behavior change.

## Scope

- **`careervine/`**: `npm audit fix` (no `--force`) — 14 non-breaking advisories, incl.
  `next` 16.1.6 → 16.2.10 (HIGH SSRF + middleware auth bypass), `dompurify` → 3.4.11, and the
  transitive `ws`/`undici`/`linkify-it` chains (lockfile bumps).
- **`chrome-extension/panel-app/`**: apply only the 4 non-breaking advisories; **exclude** the
  breaking `vite 5 → 8` / `esbuild` pair (dev-only, does not ship; that's the #121 upgrade path).
- **`careervine-mcp/`**: clean, nothing to do.

## Guardrails / risk

- The one real risk is the `next` 16.1 → 16.2 minor bump. Verify the FULL CI web matrix locally:
  `npm ci` → `tsc --noEmit` → `eslint . --max-warnings 0` → `check-ui-events` → `vitest run` →
  `next build`. Panel-app: `npm run build` + committed-bundle-freshness check.
- Do NOT take `--force` (that would pull breaking majors). If `audit fix` leaves advisories that
  only `--force` would resolve, report them, don't force.
- Merging deploys production (Vercel). No migrations/schema/secrets involved.

## Steps

1. Worktree off main (done), copy `.env.local`, `npm ci` (done).
2. `npm audit fix` in careervine; review the `package.json` + `package-lock.json` diff (confirm only
   patch/minor, no majors). Repeat scoped for panel-app.
3. Run the full verify matrix for both packages. Rebuild the panel bundle if the extension deps
   changed the output, and commit it (so CI's freshness gate passes).
4. Update `careervine/docs/audit-reports/2026-07-17/dependency-vulns.md` is NOT needed (that report
   is CAR-161's); note residual/unfixable advisories in the PR body instead.
5. Commit, push, open PR titled `... (CAR-162)`. Stop for Dawson's review (no self-merge).
