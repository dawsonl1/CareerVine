# Plan 31 - CAR-18 Add companies without contacts

**Linear:** [CAR-18 - Add the ability to add companies without a contact that works there](https://linear.app/career-vine/issue/CAR-18/add-the-ability-to-add-companies-without-a-contact-that-works-there)

## Goal

Let users create and manage a company record directly from the Companies surface even when they do not yet have any contact tied to that company. The flow should feel native to the existing company workflow and support both app UI usage and MCP-driven workflows.

## Current-state findings

- The Companies list (`careervine/src/app/companies/page.tsx`) has no direct "Add company" entry point.
- The Company detail page (`careervine/src/app/companies/[id]/page.tsx`) supports target management and recruiting notes, but only after a company already exists and is navigable.
- Current creation path for companies is contact-first (`findOrCreateCompany()` via contact create/edit in `careervine/src/lib/queries.ts`), which blocks users who want to plan target outreach before adding people.
- MCP `add_contact` tool supports optional single-company attach but there is no standalone MCP tool to add a company first (`careervine/src/mcp/tools/contacts.ts`).

## User workflow design

### Primary UI flow (new)

1. User opens `/companies`.
2. User clicks new `Add company` CTA in the header.
3. A compact modal opens with:
   - Company name (required)
   - LinkedIn URL (optional)
   - "Add to targets now" toggle (default on)
4. On submit:
   - App creates/fetches normalized company row by name/url.
   - If toggle is on, app ensures target row for the current user exists.
5. User is routed to `/companies/[id]` and sees existing target controls/notes.

### Secondary UI flow (duplicate handling)

If a likely existing company matches (name/linkedin identity), the modal resolves to that company and:
- does not create a duplicate company row,
- does not error if target already exists,
- shows a success toast ("Opened existing company target").

## UI changes

### `careervine/src/app/companies/page.tsx`

- Add `Add company` button next to existing outreach CTA.
- Add local modal state + form state.
- Add optimistic submit disable/loading state.
- Keep visual style aligned with contact modal conventions already used in `contacts/page.tsx` (rounded container, minimal fields, explicit required label).

### New component: `careervine/src/components/companies/add-company-modal.tsx`

- Encapsulate modal form UI + validation + submit callback.
- Validation:
  - Company name required and trimmed.
  - LinkedIn URL normalized if provided.
- Error copy stays user-facing and non-technical.

## Data and query layer changes

### `careervine/src/lib/company-helpers.ts`

- Extend/create helper to support standalone upsert by optional identity inputs:
  - name (required)
  - linkedin_url (optional, canonicalized)
- Matching priority:
  1. canonical linkedin identity
  2. escaped case-insensitive name
- Return existing row when matched, else create row.

### `careervine/src/lib/company-queries.ts`

- Add exported mutation:
  - `createOrResolveCompanyForUser(userId, input)`:
    - calls shared company helper,
    - optionally upserts `target_companies` row for the user,
    - returns `{ companyId, createdNewCompany, attachedToTarget }`.
- Ensure idempotence for repeated submits.

### `careervine/src/lib/queries.ts`

- Keep existing `findOrCreateCompany()` API stable for contact flows but route internals through updated helper to preserve consistency across both flows.

## MCP capability changes

### `careervine/src/mcp/tools/outreach.ts` (or best-fit tool module)

- Add new tool: `add_company`
  - Input:
    - `name` (required)
    - `linkedin_url` (optional)
    - `add_to_targets` (optional, default true)
  - Output:
    - company id/name
    - whether row was created vs resolved
    - whether target was newly attached
- Keep tool fully user-scoped using existing MCP db conventions (`uid()` scoping).
- Add a concise description for LLM agent discoverability ("Create a company before adding contacts").

## Technical implementation notes

- Reuse canonical URL normalization utilities already present in app (`linkedin-url` helpers) to avoid identity drift.
- Preserve existing dedup strategy from recent company identity work (plan 27/merge migration context).
- Avoid introducing any requirement for a contact count > 0 on company visibility:
  - companies added without contacts should still appear in Targets view if target-attached.
  - All view can remain search-driven, but target-attached companies should still render.

## Test plan

### Unit / query tests

- Add tests for standalone company creation helper:
  - creates new row with bare name,
  - resolves by linkedin identity,
  - avoids duplicate target insert.

### UI tests (Vitest/RTL where present)

- Companies page:
  - opens modal from CTA,
  - blocks submit with empty name,
  - submits and calls mutation,
  - routes to detail page id.

### MCP tests

- Schema test coverage update for new `add_company` tool.
- DB scoping test ensuring no cross-user company/target mutation.

## Rollout and Linear updates

1. Move issue to In Progress (already done).
2. Post this plan summary to CAR-18 for review traceability.
3. Implement + test.
4. Post completion note with behavior summary and test results.
5. Move issue to Done when validated.

## Risks and mitigations

- Duplicate company records from weak matching:
  - Mitigate by identity-priority matching and canonicalization before insert.
- Confusing visibility if company has no contacts:
  - Mitigate by default target attach and clear empty states on company detail.
- MCP/app behavior drift:
  - Mitigate by using shared helper in both UI and MCP paths.
