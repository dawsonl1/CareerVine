# CAR-265 — MCP writes

Second of four MCP tickets (reads → **writes** → pipeline → output schemas).

## The shape of every gap

An agent can see a problem and cannot fix it. It reads a deadline off a careers page
and cannot record it; finds a working address and cannot store it; sees a follow-up is
overdue and can only email now or leave it overdue.

## What the scoping gate demands

`src/mcp/__tests__/db-scoping.test.ts` classifies every export of `src/mcp/lib/db.ts`
and `src/lib/data/*`. The MCP service client bypasses RLS, so every recorded query must
be user-scoped, hit a global table, or key **only** on ids the same invocation proved it
owns. `updateContact` and the three follow-up deferral writers are currently `web-only`,
enforced by a source scan.

Two consequences drive the design:

1. **`updateContact` already takes `opts.userId`** and applies `.eq("user_id", userId)`.
   It is also THE canonicalization chokepoint (CAR-155) — `linkedin_url` normalization
   lives inside it. So MCP must go **through** it, not around it.
2. **`assertContactOwned` is the ownership primitive.** A scoped read that returns the
   row puts its id in the owned set, which is what lets a subsequent update key on that
   id alone. `tagContact` and `appendNote` already work this way.

**A gap worth naming:** the gate's import scan covers only `@/lib/queries`,
`@/lib/data/*` and `@/lib/company-queries`. `pipeline-queries.ts`,
`company-stage-advance.ts` and `company-helpers.ts` are outside it, so importing them
from MCP would compile and test green with zero scoping enforcement. New shared code
therefore goes in `src/lib/data/pipeline.ts`, which **is** enumerated.

## Tools

| Tool | Writes |
| --- | --- |
| `update_contact` | industry, linkedin_url, headline, met_through, follow_up_frequency_days, preferred_contact_method/value, intro_goal |
| `add_contact_email` | a new address on an existing contact, optionally primary |
| `add_contact_phone` | same for phones |
| `untag_contact` | removes tags (the add path exists; removal never did) |
| `update_company_target` | priority_score, program_name, app_window_text, **next_app_date** |
| `set_company_stage` | `target_companies.status` **and** the active cycle's `selected_stage` |
| `defer_follow_up` | snooze until a date, or skip first outreach |

Deliberately excluded: `persona` and `network_scope` (pipeline-owned, and
`set_network_status` already covers the tier), `notes` (`add_contact_note` exists), and
anything that deletes a contact — the server's no-delete stance stands.

`next_app_date` had **no writer anywhere in the app** before this. It is the field the
outreach queue orders by, so an agent could consume an ordering it had no way to improve.

## `set_company_stage` — the one that needs care

CAR-255 deleted `updateTargetCompany` this morning for being an ungated writer of
`target_companies.status`. This adds a status writer back, so it carries what that one
lacked:

- `.eq("user_id", userId)` on the update. The deleted function's only predicate was
  `.eq("id")`, and this module runs under the service client where RLS is not a backstop.
- **Both legs.** `company-stage-advance.ts:25-27` states it: the company page reads the
  cycle, the companies list reads the target row, and writing one leaves them
  disagreeing. No existing helper writes both for an arbitrary stage —
  `syncScopeStatus` writes only the target row and every caller pairs it with
  `savePipelineCycle` by hand. New `setCompanyStage` in `src/lib/data/pipeline.ts`
  does both, modelled on `advanceCompaniesForContacts:100-122`.
- **Not** gated on `is_current` or forward-only. Those invariants belong to the
  automatic reply-driven advance, which infers intent from a reply. This is the user
  saying so, the equivalent of dragging the stage in the UI, and it must be able to move
  backwards (a mis-set stage has to be correctable).

**Cache note:** CAR-256's `invalidateCompaniesList` is browser module state. Calling it
from the MCP process would invalidate nothing. A stage set through MCP therefore shows
on the list after its 5-minute TTL or the next fetch. Documented at the call site rather
than papered over with an import that does nothing.

## Primary-email demotion

There is no shared demotion helper; both web paths delete-all-then-reinsert, and the
only real logic lives in `computeEmailMerge`'s pure planner. `add_contact_email` with
`is_primary` therefore demotes existing primaries **before** inserting, matching
`bulk-import.ts:1074-1096`'s ordering, so the contact never holds two primaries.

## Tests

- A `drive` entry in `db-scoping.test.ts` per new `db.ts` export, so the gate exercises
  the scoping instead of taking it on trust. This is the primary safety net.
- Handler tests in `src/mcp/__tests__/`, driving the real tools through the fake-server
  harness CAR-262 introduced.
- Falsify each: drop the `user_id` filter and confirm the gate fails.

## Verification

`npm run test`, `npm run test:coverage` (the `src/mcp/**` branch ratchet), `check:conventions`,
`test:integration`, `npm run build`.
