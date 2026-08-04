# CAR-55 — Company page: BYU alumni contacts at the top of the contacts list

## Problem

On the company detail page, the contacts list (both "Your network" and "Prospects" groups, current and former employees) is ordered by persona rank — `recruiter → product_leader → alum_product → product_peer → alum_other` — then name. BYU alumni who happen to carry a non-alum persona (e.g. a recruiter or product peer who is also BYU) sort by their persona, and `alum_*` personas sort below recruiters/leaders. Dawson wants BYU alumni always at the top.

## Where the order is decided

- `careervine/src/lib/company-queries.ts` — `getCompanyDetail` sorts `current` and `former` with `byPersona` (`personaRank` + name tiebreak) at ~lines 836–839. The UI (`pipeline-layout.tsx`) preserves this order; it only filters/groups.
- Each `CompanyPerson` already carries `is_alum`, computed from the `contact_schools`→`schools` BYU name match plus `contacts.verified_school ∈ {BYU, BYU-Idaho, Marriott}`.

## Change

Single-file change in `company-queries.ts`:

```ts
const byAlumThenPersona = (a: CompanyPerson, b: CompanyPerson) =>
  Number(b.is_alum) - Number(a.is_alum) ||
  personaRank(a.persona) - personaRank(b.persona) ||
  a.name.localeCompare(b.name);
```

Apply to `current` and `former`. Bench keeps its adjacency ranking (it's the pipeline's own scoring, not the visible contacts list).

Effect in the UI: within each of "Your network" and "Prospects", BYU alumni first (persona order preserved among alumni), then everyone else in today's order.

## Tests

Extend the existing company-queries test coverage (or add a focused unit test) asserting: an `is_alum` contact with a low-rank persona sorts above a non-alum recruiter in both `current` and `former`; persona order still ties-breaks among alumni; bench order unchanged.

## Verification

`npm run test` from `careervine/`. No schema, no new domain — but this rides its own worktree since it's already open.
