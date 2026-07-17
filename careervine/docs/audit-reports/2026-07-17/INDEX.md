# Overnight housekeeping audit bundle — 2026-07-17

Generated for [CAR-161](https://linear.app/career-vine/issue/CAR-161). Read-only audits,
Dependabot triage, and trivial cold-zone fixes. Nothing here touches hot files or the
Straight A's critical path; no PR was merged.

| # | Report | Scope | Headline findings |
|---|--------|-------|-------------------|
| 1 | [coverage-gaps.md](coverage-gaps.md) | Test-coverage gap map | 59.5% stmt coverage; 201/400 modules have zero tests. 40 risk-ranked gaps (Apify billing, Google Calendar, MCP tool handlers near-dark; crypto/BYOK well covered). |
| 2 | [dependency-vulns.md](dependency-vulns.md) | Dependency vulnerabilities | 20 advisories (10 high / 8 moderate / 2 low, 0 critical). 18 non-breaking fixes; only vite 5→8 (dev-only) breaks. careervine-mcp clean. |
| 3 | [dead-code-inventory.md](dead-code-inventory.md) | Dead code / unused exports | 20 fully-dead exports safe to delete now (non-hot); ~30 more over-exported (un-export only). knip advisory (no config). No deletions made. |
| 4 | [accessibility-audit.md](accessibility-audit.md) | Accessibility audit | _pending_ |
| 5 | [copy-sweep.md](copy-sweep.md) | User-facing copy sweep | _pending_ |
| 6 | [public-pages-perf.md](public-pages-perf.md) | Public-pages performance | _pending_ |
| 7 | [dependabot-triage.md](dependabot-triage.md) | Dependabot backlog triage | _pending_ |

## Cold-zone fixes applied

_pending_

## Notes

- Report location mandated by the ticket: `careervine/docs/audit-reports/2026-07-17/`.
- This INDEX is appended to as each report lands, then finalized in Task 8.
