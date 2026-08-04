# Plan 31 — Standalone Company + Location Creation (CAR-18, CAR-14)

**Linear:**
- [CAR-18 — Add the ability to add companies without a contact that works there](https://linear.app/career-vine/issue/CAR-18/add-the-ability-to-add-companies-without-a-contact-that-works-there)
- [CAR-14 — Add addability to create company locations without having somebody, a contact attached to there](https://linear.app/career-vine/issue/CAR-14/add-addability-to-create-company-locations-without-having-somebody-a)

## Goal

Allow users to create and manage companies (and company offices/locations) before they have any known contacts at those companies, with a clear UI path and MCP parity.

Outcome:
- Users can add a company directly from the Companies area without creating a contact.
- Users can add one or more office locations to a company without relying on `contact_companies` rows.
- The company appears in Targets/Company Detail workflows immediately and can accumulate recruiting notes/workflow state from day one.
- MCP tools can do the same operations.
- Companies created without contacts remain discoverable in the product.

## Current state (relevant code)

- Companies list is read-only and derived from existing employment/targets:
  - `careervine/src/app/companies/page.tsx`
  - `careervine/src/lib/company-queries.ts#getCompanies`
- Company detail supports:
  - Add company to targets (`addTargetCompany`)
  - Manage existing offices by delete only
  - Recruiting notes
  - Files: `careervine/src/app/companies/[id]/page.tsx`, `careervine/src/lib/company-queries.ts`
- Data-layer mutation for adding office already exists but is not surfaced in UI:
  - `careervine/src/lib/company-queries.ts#addCompanyOffice`
- Contacts flow can create companies only as a side-effect of adding a contact:
  - `careervine/src/app/contacts/page.tsx` (work experience section)
  - `careervine/src/lib/queries.ts#findOrCreateCompany` and `#addCompanyToContact`
- MCP currently has contact-centric creation but no standalone company/location creation tools:
  - `careervine/src/mcp/tools/contacts.ts`
  - `careervine/src/mcp/lib/db.ts`

## Product + UX design

### 1) Add company entry points

Primary entry point in Companies page:
- Add `+ Add company` button in `careervine/src/app/companies/page.tsx` header.
- Opens modal (`CreateCompanyModal`) collecting:
  - Company name (required)
  - LinkedIn URL (optional)
  - Domain (optional)
  - Universal name (optional hidden/advanced field or auto-derive later)
  - “Add to targets now” toggle (default on)
  - Optional initial offices section (city/state/country entries)
  - Validation:
    - `name`: required, trimmed, non-empty.
    - `linkedin_url`: optional but URL-validated (LinkedIn-host check preferred).
    - `domain`: optional, normalized to lowercase host form (no protocol/path).
  - UX behavior:
    - Focus starts on name field.
    - Primary button disables while request is in-flight.
    - Inline field errors keep user input intact.

Secondary entry point on empty states:
- For Targets-empty and All-empty states, provide CTA to open same modal.

Create success behavior:
- Close modal, show success toast, and navigate to company detail.
- If target toggle was on: toast says company was added and targeted.

### 2) Company detail office management completion

Extend current “Manage offices” block in `careervine/src/app/companies/[id]/page.tsx`:
- Add “Add office” inline control.
- Location entry: city/state/country via `findOrCreateLocation`-style behavior.
- Optional duplicate guard messaging if office already exists.
- Preserve current delete semantics and explanatory copy.
- Add explicit empty state when no offices exist with a primary "Add office" CTA.
- Add explicit "No contacts yet" microcopy for standalone-company records.

### 3) Workflow expectations

User flow A (CAR-18):
1. Companies page -> Add company.
2. Save with zero contacts.
3. Auto-optional target creation.
4. Redirect/open company detail.
5. User can immediately add notes, app dates, status, etc.
6. If “Add to targets now” is off, company still appears in All view so it remains discoverable.

User flow B (CAR-14):
1. Company detail -> Manage offices.
2. Add location(s) without contacts.
3. Office facets become available immediately.

Failure/edge behavior:
- Validation errors stay in-place in modal with no data loss.
- Duplicate office attempts return non-fatal “already exists” feedback.
- Server errors preserve form state and allow retry.

## Data/model implementation

### 1) Company creation mutation

Add dedicated query-layer mutation in `careervine/src/lib/company-queries.ts`:
- `createCompany(input: { name: string; linkedin_url?: string | null; domain?: string | null; universal_name?: string | null; })`
- Reuse `findOrCreateCompany` helper behavior from `careervine/src/lib/company-helpers.ts` to avoid duplicate company names and race conditions.
- Return created/found company id and metadata needed by UI.
- Canonical identity rules:
  - Prefer `universal_name` when provided.
  - Else prefer normalized `domain` when provided.
  - Else fall back to normalized name (trimmed, case-insensitive).
- Return `{ created: boolean }` style metadata so UI and MCP can report reuse vs new creation.

### 2) Optional target initialization at creation

If “Add to targets now” is enabled:
- call existing `addTargetCompany(userId, companyId)`.
- optionally include initial status defaults via current table defaults.
- When user requested target creation, treat failure as whole-operation failure (no silent partial success).

### 3) Office creation path

Leverage existing `addCompanyOffice(companyId, locationId)` in `company-queries.ts` with:
- UI helper to normalize/create location id first.
- Reuse or move existing `findOrCreateLocation` from `careervine/src/lib/queries.ts` into a shared location module so both contacts and companies use one normalization/dedupe path.
- Location normalization key remains `(city, state, country)` with consistent trimming/casing.
- For create-company modal, include initial office inserts in same transaction scope when feasible.

### 4) Query behavior validation

Ensure `getCompanies` returns:
- Newly-created target-only companies with no contacts.
- Newly-created standalone companies with no contacts and no targets (discoverable in All view).

## MCP capability parity

Add tools for remote/agent workflows:

In `careervine/src/mcp/tools/outreach.ts` or new `companies.ts` tool module:
- `add_company`
  - Inputs:
    - `name` (required)
    - `linkedin_url` (optional)
    - `domain` (optional)
    - `universal_name` (optional)
    - `add_to_targets` (optional, default true)
    - `offices` (optional array of `{ city, state?, country }`)
  - Behavior:
    - Uses same canonical company creation path as UI (idempotent).
    - If company already exists, returns it; can still ensure target exists when requested.
  - Output:
    - `company_id`, `created`, `target_created`, `offices_created`
- `add_company_office`
  - Inputs:
    - `company_id` (preferred) or `company_name`
    - location `{ city, state?, country }`
  - Behavior:
    - Name lookups must reject ambiguous matches with disambiguation error.
    - Find/create location then idempotent office association.
  - Output:
    - `company_id`, `office_id`, `created`

Auth/safety:
- Tools run in authenticated user context and preserve tenant/user scoping.
- Add defensive limits for office batch size in one tool call.

And wire registrations in server bootstrap where MCP tools are registered.

## Technical implementation steps

1. Add/expand company query mutations
- `careervine/src/lib/company-queries.ts`

2. Add reusable UI modal(s)
- `careervine/src/components/companies/create-company-modal.tsx` (new)
- Optional shared `office-editor` subcomponent if needed.

3. Integrate in Companies page
- `careervine/src/app/companies/page.tsx`

4. Integrate add-office UX in Company detail
- `careervine/src/app/companies/[id]/page.tsx`

5. Add MCP tools + register
- `careervine/src/mcp/tools/companies.ts` (new) or extend existing tools file
- registration entry file(s) under `careervine/src/mcp/`

6. Add/extend typings if needed
- `careervine/src/lib/types.ts`

## Test plan

### Unit / query tests

- `getCompanies` includes target-only companies with zero contacts.
- `getCompanies` includes standalone companies with zero contacts and zero targets.
- `createCompany` is idempotent by name (or documented behavior if not strict idempotence).
- `addCompanyOffice` handles duplicate office insert safely.
- Canonical company dedupe across case/spacing/domain variants.
- Location dedupe across city/state/country normalization variants.
- Transactional behavior for create+target+initial-offices path (no silent partial state).

### UI behavior tests

- Companies page “Add company” modal create success path.
- Create with “add to targets on/off” toggles expected target state.
- Company detail office add path updates facet chips/list.
- Success redirect lands on company detail with expected empty states.
- Validation and server-error states keep modal input + show clear errors.
- Modal keyboard behavior (focus/escape/submit) works.

### MCP tests

- Tool schemas include `add_company` and `add_company_office`.
- Tool calls create company/office and return expected structured summaries.
- `add_company` idempotence on repeated calls.
- `add_company_office` ambiguous-name resolution error behavior.
- Invalid URL/domain/location inputs return descriptive tool errors.

### Regression checks

- Existing contact creation/edit paths still work.
- Existing company target/note/status flows unchanged.
- Contact creation path reuses canonical company dedupe behavior to prevent drift.

## Deployment and rollout

- Keep scope to one unified PR for both issues due shared surfaces.
- Update README (product-facing) after feature completion:
  - Mention users can build target company pipeline and office map before adding contacts.
- Update both Linear issues through:
  - In Progress (now) -> implementation update comment -> Done with test evidence.

## Risks and mitigations

- Duplicate-company fragmentation:
  - Mitigate via shared canonical create/find helper.
- Office duplicates:
  - Keep DB upsert on `(company_id, location_id)` and UX duplicate messaging.
- Scope creep in “company profile enrichment”:
  - Keep this iteration focused on manual creation and office association only.
