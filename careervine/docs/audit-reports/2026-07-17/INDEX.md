# Overnight housekeeping audit bundle — 2026-07-17

Generated for [CAR-161](https://linear.app/career-vine/issue/CAR-161). Read-only audits,
Dependabot triage, and trivial cold-zone fixes. Nothing here touches hot files or the
Straight A's critical path; no PR was merged.

| # | Report | Scope | Headline findings |
|---|--------|-------|-------------------|
| 1 | [coverage-gaps.md](coverage-gaps.md) | Test-coverage gap map | 59.5% stmt coverage; 201/400 modules have zero tests. 40 risk-ranked gaps (Apify billing, Google Calendar, MCP tool handlers near-dark; crypto/BYOK well covered). |
| 2 | [dependency-vulns.md](dependency-vulns.md) | Dependency vulnerabilities | 20 advisories (10 high / 8 moderate / 2 low, 0 critical). 18 non-breaking fixes; only vite 5→8 (dev-only) breaks. careervine-mcp clean. |
| 3 | [dead-code-inventory.md](dead-code-inventory.md) | Dead code / unused exports | 20 fully-dead exports safe to delete now (non-hot); ~30 more over-exported (un-export only). knip advisory (no config). No deletions made. |
| 4 | [accessibility-audit.md](accessibility-audit.md) | Accessibility audit | 19 findings (7 serious): no dialog semantics/focus mgmt, unlabeled icon controls, keyboard-dead custom Select, placeholder-only auth inputs. Color/alt/lang layer solid. 4 cold fixes applied. |
| 5 | [copy-sweep.md](copy-sweep.md) | User-facing copy sweep | 8 findings, none critical. Top: oauth consent hardcodes "Claude"; one pipeline-stage label split ("Outreach active" vs "Active outreach"). No em dashes, no broken doc anchors, no typos. Cold edits report-only (judgment calls). |
| 6 | [public-pages-perf.md](public-pages-perf.md) | Public-pages performance | Docs page already well-optimized: 0 external requests, ~20KB gzip, 0 raster images, ~0% unused CSS. Only 4 minor hygiene fixes (minify, SVG dedupe, delete 5 unused starter SVGs). Static analysis (no dev server). |
| 7 | [dependabot-triage.md](dependabot-triage.md) | Dependabot backlog triage | _pending_ |

## Cold-zone fixes applied

Only trivial, obviously-correct fixes in the cold zone (`public/docs/index.html`,
`app/{auth,privacy,terms,reset-password,oauth}/**`) were applied. Everything requiring
judgment or in a hot file is report-only.

- **`app/reset-password/page.tsx`** (Task 4, a11y) — associated both password `<label>`s
  with their `<input>`s via `htmlFor`/`id` (`new-password`, `confirm-password`). Previously
  the labels were unassociated (WCAG 1.3.1 / 3.3.2). Verified: `tsc --noEmit` + `eslint` clean.

### Deliberately NOT applied (reported instead — need judgment / not obviously-correct)

- **`app/oauth/consent/page.tsx`** copy-sweep S1 (hardcoded "Claude" in title/subtitles) —
  a real bug, but a behavior change on a deliberately Claude-branded OAuth consent (security)
  surface; the generic fallback name (`"An application"`) reads awkwardly. Left for a human
  product call (see `copy-sweep.md` S1).
- **`public/docs/index.html:791`** copy-sweep T2 ("Outreach" → "Outreach active") — the app
  itself is internally inconsistent ("Outreach active" vs "Active outreach"); picking one is a
  terminology decision owned by CAR-157 (see `copy-sweep.md` T1/T2).

## Notes

- Report location mandated by the ticket: `careervine/docs/audit-reports/2026-07-17/`.
- This INDEX is appended to as each report lands, then finalized in Task 8.
