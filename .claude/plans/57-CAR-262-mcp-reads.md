# CAR-262 — MCP reads: paging, restored signals, honest traction

First of four MCP tickets (reads → writes → pipeline → output schemas).

## 1. Truncation with no way past it

Three tools capped a list and offered no recovery, so the data beyond the cap was
simply unreachable through the server.

- **`get_company`** capped 50 current / 50 former / 25 archived. Person #51 at a
  large company could not be read at all. Now `limit` + `offset`, plus a `group`
  parameter to narrow to one roster before paging.
- **`get_email_thread`** returned the newest 10 with no offset, so a long thread's
  opening message was unreachable. Now `limit` + `before_index`, walking backwards;
  windows tile exactly, so paging back reconstructs the whole thread.
- **`get_network_health`** capped the neglected list at 15 with no parameter and no
  total, which read as "these are the neglected contacts". Now `neglected_limit`
  plus `neglectedTotal`.

Every paged response states its window and how to get the next one. A bare count
beside a silently truncated list is how an agent concludes it has seen everything.

## 2. Signals computed and then dropped

- `compactCompany` now carries `traction_detail` (the difference between
  "call_done" and "2 calls done, 3 weeks ago"), the alumni/recruiter counts,
  `lead_contact_name`, `linkedin_url`, and the full target block.
- `get_company`'s person projection adds `selection_reason` and `adjacency_score`
  (an agent was ranking a roster with no signal to rank by), `current_position`
  (for a former employee, the difference between a dead lead and a warm one
  somewhere new), `last_interaction`, `linkedin_url`, and per-role dates/location.
- `offices` becomes objects carrying `location_id` — which `add_company_intel`
  takes as a parameter that no tool previously handed out — plus `office_facets`,
  the per-office headcount that was computed and discarded whole.
- `list_scheduled` returns the follow-up `steps` it already fetched and threw away.
  Without them an agent could not see what was about to be sent in the user's name,
  and `reschedule_follow_up` asked for a `sequence_number` nothing revealed.

## 3. Uncomputed values reported as zero

`getCompanies` skipped the who-you-know pass for `scope: "all"` (7,433 companies,
genuinely too expensive) **while the return type went on claiming enriched**. The
five fields arrived as `0`/`null`, and MCP `list_companies(targets_only:false)` read
them straight out: every company reported no traction and no alumni,
indistinguishable from genuinely having none. An agent acting on that re-emails
someone contacted last week.

Fixed at the source rather than papered over in the tool. The codebase already had
the right mechanism — `enrich: false` makes those fields **structurally absent** so
a wrong read is a compile error — and `scope: "all"` was the one path that escaped
it. The enriched overload no longer accepts `"all"`, so:

- an "all" search must pass `enrich: false` and gets `CompanyBaseSummary`;
- `list_companies` branches on the two shapes and sets `traction_included`;
- a runtime throw backs the type, because the MCP layer builds options from JSON
  and is invisible to TypeScript.

## Tests

`mcp-read-paging.test.ts` pins the windowing arithmetic and the paging prose,
including the two cases that read as data rather than as paging: an empty page past
the end, and a last page that must stop advertising a next one.

Two existing tests asserted the OLD behavior and were **inverted, not deleted**:
`company-enrich-option.test.ts`'s "does not change the `all` scope, which returns
the fields as 0/null" (that was the defect) and the type-test's assertion that
`scope: "all"` compiles as enriched, which is now a `@ts-expect-error`.

## Docs

`careervine-mcp/README.md` said "Tools (28)" against an actual 29 and omitted
`reschedule_follow_up`. Both corrected, plus a section on paging and the traction
omission.

## Verification

`npm run test` 3892, `check:conventions`, `npm run build`, `test:integration` 54.
