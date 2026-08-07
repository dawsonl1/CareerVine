# CAR-244 — Company traction and next action must read current employees

## Diagnosis (verified against production, not inferred)

BambooHR's card claims "Contacted" and "Waiting on Preston. Follow up if it's been a while".

- Preston Jackson (#1228): Account Executive, Jan 2014 → Mar 2016, `is_current = false`.
- He is the **only** BambooHR contact with any outreach: one outbound email.
- All 10 current employees are untouched.
- `current_count = 10` is correct and already current-only. The people count is NOT part of
  this bug; only the traction chip and next-action line are.

`getCompanies` (`company-queries.ts:967`) computes `best` (max derived stage + the contact
driving it) over `people`, which is every non-bench contact, current and former. The three
lines directly above it (`alumCount`, `productAlumCount`, `recruiterCount`) already filter to
`current`. Only this pass does not.

Second-order effect, worse than the wrong name: `traction === "contacted"` fires the rank-56
branch of `nextActionForCompany`, which outranks the warm-intro branch (rank 44). BambooHR has
5 untouched alumni in product, so the correct line is "Reach out to <alum>, your alum in
product". A contact who left in 2016 is suppressing the company's real next move.

## Decision

Dawson chose **current only, with former as fallback when nobody current remains** (2026-08-06).

```js
// Traction describes your position at the company you could still walk into,
// so it reads current employees. A company where everyone has left keeps its
// real history rather than going blank.
const tractionPool = current.length > 0 ? current : people;
```

`people` is already non-bench, so when `current` is empty `tractionPool` is exactly the former
contacts. No third branch needed.

Accepted trade-off, recorded so it is not re-litigated as a bug: a contact you are mid-thread
with who changes jobs takes their traction out of that company's chip.

## Blast radius

`traction` feeds three consumers, all of which inherit the correction:

- the next-action line (`company-next-action.ts`)
- the "Filter by traction" dropdown (`company-filters.ts:66`)
- the `traction` sort on /companies

`lead` feeds only the next-action line. Its existing `else if (current.length > 0)` warm-intro
fallback is already current-only and needs no change.

## Files

- `careervine/src/lib/company-queries.ts` — the one pass, ~4 lines.
- `careervine/src/__tests__/company-traction-current-only.test.ts` — new.

## Verification

- A former contact with outreach + untouched current contacts must yield `traction` from the
  current pool and a warm-intro next action, not "Waiting on <former>".
- A former-only company must keep its former-driven traction (the fallback).
- Falsify each assertion by reverting the pool to `people` before keeping it.
- `npm run test`, `check:conventions`, `lint`, `build`.
