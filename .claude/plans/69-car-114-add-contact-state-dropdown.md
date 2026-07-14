# CAR-114 — Normalize contact state entry with a US state dropdown

## Problem

The **State** field in the add/edit contact forms is a free-text `<input placeholder="e.g. CA">`. Users type "CA" / "California" / "Calif." interchangeably, so `locations.state` accumulates inconsistent values. `findOrCreateLocation` matches on exact `state` equality and `locationMatchKey` compares lowercased state, so "CA" and "California" split into two location rows for the same place. The scrape/import pipeline (`location-normalizer.ts`) already writes the canonical **full state name** ("California"), so a hand-added contact and the same person imported from LinkedIn currently land in *different* location rows.

## Approach

Replace the free-text State input with a normalized, country-aware `StateSelect` that stores the same canonical full state name the import pipeline produces.

### Canonical form
Full state name ("California", not "CA"). Matches `location-normalizer.ts`. `usStateCode()` (compact display labels) already accepts full names → no display regression.

### Country-aware
- Country is United States (default, or empty, or a US alias) → M3 `Select` dropdown of 50 states + DC (values = full names).
- Any other country → free-text `State / Province` input (keeps international entry working: Ontario, Bavaria, ...).

### Single source of truth
Extract the state list to `careervine/src/lib/us-states.ts`; `location-normalizer.ts` imports `US_STATES` from it (pure data move, behavior unchanged — guarded by `location-normalizer.test.ts`). The dropdown and the normalizer can never drift.

## Files

**New**
- `careervine/src/lib/us-states.ts` — `US_STATES` (code→name), `US_STATE_OPTIONS` (`{value,label}` full names, alpha-sorted), `canonicalUsState(input)` (code|name, any case → canonical full name | null), `isUnitedStates(country)` (empty/US aliases → true).
- `careervine/src/components/ui/state-select.tsx` — `StateSelect({ value, onChange, country, required? })`. US → `Select` with `US_STATE_OPTIONS` (+ transient option for an unrecognized legacy value so nothing silently disappears); non-US → text input styled with `inputClasses`. Trigger bg overridden to `bg-surface-container-low` to match sibling City/Country inputs.

**Edit**
- `careervine/src/lib/location-normalizer.ts` — import `US_STATES` from `./us-states` (delete the inline copy; keep the derived `US_STATE_NAMES`).
- `careervine/src/app/contacts/page.tsx` (add form, ~L786) — swap State `<input>` for `<StateSelect country={formData.location_country} value={formData.location_state} onChange={...} />`.
- `careervine/src/components/contacts/contact-edit-modal.tsx` (~L288) — same swap; canonicalize `location_state` on populate (~L84) so legacy values heal.
- `careervine/src/components/contacts/contact-info-header.tsx` (~L433) — same swap; canonicalize on populate (~L84).

## Tests
- `careervine/src/__tests__/us-states.test.ts` — `canonicalUsState` (code→name, full name any case→name, junk→null), `US_STATE_OPTIONS` (51 entries, sorted, values are full names), `isUnitedStates` (""/"USA"/"us"→true, "Canada"→false).
- `careervine/src/__tests__/state-select.test.tsx` — renders a text input when country is non-US; renders the state dropdown (with the value selectable) when US.
- Run existing `location-normalizer.test.ts` to confirm the constant extraction is behavior-neutral.

## Verify
`npm run test` + `npm run build` from `careervine/`. Manual smoke of the add form in the preview browser (dropdown appears for US, text for non-US) since this is a form-input change.

## Out of scope (follow-ups)
- MCP `add_contact` writes state unnormalized (`src/mcp/lib/db.ts`).
- `location-tab-label.ts` inverse map could later derive from `us-states.ts`.
- Backfill of existing non-canonical `locations.state` rows.
