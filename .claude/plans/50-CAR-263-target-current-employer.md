# CAR-263 — Adding a person targets their current employer

## Problem

None of the nine paths that create a `companies` row ever creates a
`target_companies` row. Save someone who works at Goldman Sachs and Goldman Sachs
stays untargeted: it appears on /companies only through the `in_play` scope, never
as a target, and no status chip can reach it.

## Scope, chosen against measured data

Measured on production before deciding, because the naive reading is enormous:

| | |
| --- | --- |
| Companies with a current non-bench contact | 657 |
| Already targeted company-wide | 327 |
| Overlap | 129 |
| Rows a full backfill would create | **528** |

327 -> 855 targets, all 528 new ones in Researching. Two decisions followed:

- **No backfill.** Going-forward only.
- **Deliberate adds only.** Bulk paths do not target, so a ~2,000-prospect bundle
  apply cannot flood the list.

## Design

One shared helper, `ensureCompanyTargets(supabase, userId, companyIds)`, in
`company-helpers.ts` (explicit client, matching `findOrCreateCompany`), plus a
seam wrapper in `company-queries.ts` for browser and MCP callers.

`company-queries.ts` rather than `data/contacts.ts` for the wrapper, for two
reasons: this is target bookkeeping, not contact data; and this module's client
seam is the one MCP injects into (`setCompanyQueriesClient`), so browser and MCP
share one wrapper instead of two. The MCP governance suite made the first attempt
fail loudly, which was the right signal.

### Three load-bearing rules

1. **Current employment only.** A profile save mints a company row for every job
   in the person's history, and `experience` has no cap in the payload schema, so
   an ungated version would target fifteen past employers from one save.
2. **Missing rows only; `is_targeted` is never written.** A company the user
   untargeted must stay untargeted when another contact there shows up. This is
   CAR-258's rule at a second call site.
3. **Company-wide scope only** (`location_id IS NULL`). Office-level targeting is
   a deliberate per-office act.

Plus: never throws (a contact save must not fail on target bookkeeping), swallows
the 23505 concurrent saves race into, and the read carries a deliberate
`.limit(chunk.length)` justified by the partial unique index.

## Call sites

1. `api/contacts/import/route.ts` — extension save. `addExperienceToContact` now
   returns the current-employer ids; both callers have the user id.
2. `app/contacts/page.tsx` — add-contact form.
3. `mcp/lib/db.ts` `createContactFull` — MCP `add_contact`.
4. `api/discovery/candidates/[id]/add/route.ts` — discovery "Add".
5. `components/contacts/contact-edit-modal.tsx` — beyond the four named, because
   adding a current employer there is the same deliberate act, and excluding it
   would make "add contact at Stripe" and "add contact, then edit to add Stripe"
   behave differently.

## Verification

`npm run test` (3905), `tsc --noEmit`, `lint`, `check:conventions`, `build`.

Every new assertion falsified: writing `is_targeted` fails 4 helper tests,
dropping the company-wide filter fails the scope test, and removing the
`is_current` gate fails 2 route tests.

No migration, no schema change, no prod apply.
