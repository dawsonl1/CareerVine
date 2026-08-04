# CAR-118 — MCP add_contact: normalize state (sibling of CAR-114)

## Problem

`createContactFull` in `careervine/src/mcp/lib/db.ts` (~L262) passes the caller-supplied `location.state` straight to `findOrCreateLocation`, which matches locations on exact `state` equality. An agent passing "CA" therefore creates a different `locations` row than "California" — the canonical full name the scrape/import pipeline and the CAR-114 web dropdown both store. Same duplication bug CAR-114 fixed on the web, still open on the MCP path.

## Approach

Canonicalize state at the single MCP write site, reusing CAR-114's shared source of truth (`us-states.ts`) so MCP, web, and the import pipeline all agree.

## Changes

- `careervine/src/mcp/lib/db.ts` — in `createContactFull`, before `findOrCreateLocation`: when `isUnitedStates(location.country)`, map state through `canonicalUsState(state) ?? state`; non-US passes through untouched. Import `canonicalUsState, isUnitedStates` from `@/lib/us-states`.
- `careervine/src/mcp/tools/contacts.ts` (~L56) — add a `.describe()` on the schema `state` field nudging agents toward the full state name (e.g. "California").

## Test

- `careervine/src/mcp/__tests__/add-contact-location.test.ts` — service-client builder-mock (pattern from `db-scoping.test.ts`), mock `@/lib/analytics/server`. Assert:
  - `{ city: "San Francisco", state: "CA", country: "United States" }` → `locations` lookup filters include `["state", "California"]`.
  - already-canonical + unrecognized US state pass sensibly (full name stays; junk falls back to raw).
  - `{ state: "ON", country: "Canada" }` → `["state", "ON"]` unchanged.

## Verify

`npm run test` + `npm run build` from `careervine/`.

## Dependency / merge order

Depends on `us-states.ts` from CAR-114 (PR #80, unmerged). Branch stacked on `dawson/CAR-114-add-contact-state-dropdown`; PR base = that branch. Merge #80 first, then retarget this to `main` and merge.
