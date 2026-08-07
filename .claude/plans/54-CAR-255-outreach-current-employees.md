# CAR-255 — Active outreach records only current employees

## The complaint

On a company page, the Active outreach stage lists "Contact made with …" for people
who **used to** work there. Outreach to a former employee is being presented as
outreach at the company.

## What is actually wrong (and what is not)

**Activation is already correct.** Two independent gates were checked:

- `advanceCompaniesForContacts` (`careervine/src/lib/company-stage-advance.ts:64-74`)
  joins `contact_companies` with `.eq("is_current", true)` before it touches
  `target_companies.status`. It is the ONLY automatic writer of `outreach_active`
  (the other writer is `usePipelineAutosave`, i.e. the user moving the stage by hand).
- The CAR-243 backfill migration
  (`supabase/migrations/20260807030000_car243_backfill_outreach_active_on_reply.sql:70-74`)
  carries the same `cc.is_current = true` join.

Measured against production 2026-08-07 — all 12 `target_companies` rows sitting at
`outreach_active` have a **current** employee who replied:

| company | current touched | current replied | former replied |
| --- | --- | --- | --- |
| Adobe | 1 | 1 | 2 |
| Podium | 2 | 1 | 0 |
| R1 RCM | 1 | 1 | 1 |
| Hona / WGU / ZAGG | 1 | 1 | 1 |
| Brevium, CapitalROCK, Doxy.me, Entrata, Helpside, Quilt | 1 | 1 | 0 |

So **no status needs reverting** and no corrective data migration is warranted.
Writing one would be writing an UPDATE with an empty match set.

**The record is what is broken.** `PipelineLayout` passes
`people={filteredPeople}` into `RecruitingPanel`
(`careervine/src/components/companies/pipeline/pipeline-layout.tsx:1501`), and
`filteredPeople` is `[...filteredCurrent, ...filteredFormer]` (:1338-1341).
`RecruitingPanel` then derives the record with no employment gate:

```ts
const outreachContacts = people.filter(
  (p) => p.stage && p.stage !== "not_contacted" && p.stage !== "bounced",
);
```

That single expression carries two defects:

1. **Former employees are recorded.** Adobe shows 4 former-employee touches, Podium 4,
   R1 RCM 4. Every sibling surface already gates on `is_current`: the companies-list
   traction chip (CAR-244/246, `company-queries.ts:1163-1180`), the roster split
   (CAR-241, `company-queries.ts:1750-1761`), the stage advance (CAR-243). The
   pipeline panel is the last one reading over everyone.
2. **The roster search rewrites the record.** `filteredPeople` is search-filtered, so
   typing in "Search contacts" changes what the Active outreach stage claims happened,
   and a query matching nobody empties it. The comment at :1335-1337 already asserts
   the panel "speaks for the whole company"; the prop contradicts it.

Because the record is derived at render time, fixing the filter corrects every
company retroactively. That IS the backfill.

## Change

`careervine/src/components/companies/pipeline/pipeline-layout.tsx`

- Pass the scope's **unfiltered current** roster to `RecruitingPanel` instead of
  `filteredPeople`. Bench stays excluded (it is a separate array upstream), which
  matches the traction chip: an archived contact is not company traction.
- Keep the derivation in one place and comment it with the invariant, so the next
  person does not re-widen it.

## Tests

New `careervine/src/__tests__/company-outreach-record-current-only.test.tsx`, mirroring
the CAR-241 harness (`company-contacts-former-collapse.test.tsx`):

1. A former employee at `contacted` is NOT recorded under Active outreach.
2. A current employee at `contacted` IS recorded.
3. Typing a roster search that matches nobody leaves the record intact.
4. A company whose ONLY touched person is former shows "No outreach logged yet".
5. Falsification: revert the filter and confirm 1 and 4 fail.

**No new activation test needed** — checked rather than assumed.
`company-stage-advance.test.ts:180` ("NEVER advances a company the contact has already
left") and `:192` ("advances only the current employer when the contact has both")
already pin it, and the stub at `:59-62` honours `eq:is_current` **only when the query
sends it**, so deleting `.eq("is_current", true)` from the source makes both fail
rather than silently pass. The gate is genuinely guarded.

## Also in scope

`company-queries.ts` exported `updateTargetCompany(targetId, patch)` with `status` in
its patch type, zero callers, and none of the gates the real writers carry: no
`is_current` check, no forward-only re-assertion, no `user_id` scoping on the UPDATE.
It was the last ungated writer of `target_companies.status`, so wiring it up would have
re-opened exactly this defect. Deleted, with a comment naming the two sanctioned
writers in its place.

## Docs

`careervine/public/docs/index.html` — check whether the company-pipeline section
describes what Active outreach counts; update if it promises anything broader.

## Verification

`npm run test`, `npm run check:conventions`, `npm run test:integration`, `npm run build`
from `careervine/`.
