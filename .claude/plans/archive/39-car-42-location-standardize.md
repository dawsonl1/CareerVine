# CAR-42 — Extension panel: stop mangling international locations (USA-append bug)

The full plan lives on the ticket (already audited by a code-verifying subagent on 2026-07-10; amendments incorporated there). This file is the execution checklist.

## Root cause

`standardizeLocation` in `chrome-extension/panel-app/src/App.tsx` assigns `country = "USA"` to **every** unrecognized 2-part location (the length heuristic at ~:432-435 and the final else at ~:436-440), so "London, UK" → "London, UK, USA". Display-only; also mangles experience/company locations at the two other call sites.

## Steps

1. **Extract pure helpers** into `chrome-extension/panel-app/src/lib/profile-format.ts`:
   `standardizeLocation`, `parseAnyDate`, `standardizeMonth`, `calcDuration`, `deriveContactStatus`, plus the module constants they close over (`STATE_ABBREVS`, `MONTH_ABBREVS`, `MONTH_FULL`, `MONTH_NAMES`). `deriveContactStatus` takes a structural education type so App.tsx's `Education` stays put. Add a `now: Date = new Date()` param to `calcDuration`. App.tsx imports what it still uses (incl. `MONTH_ABBREVS` for the date-suggestion dropdown).

2. **Rewrite `standardizeLocation`** — never invent a country that wasn't in the input:
   - 2-part: US state (key or value of `STATE_ABBREVS`) → "City, ST, USA"; US synonym → "City, USA"; anything else → pass through unchanged.
   - 3-part: unchanged from today — abbreviate recognized US states, keep the country-standardization block so "…, Utah, United States" → "…, UT, USA".
   - Keep work-arrangement (Remote/Hybrid) and job-type filtering as-is.
   - Decided tradeoffs (encoded as tests): "Tbilisi, Georgia" → "Tbilisi, GA, USA"; "Washington, D.C." becomes pass-through.

3. **Extension-side country default** in `enrichProfile`: `location.country ?? "United States"` → `?? null`. Servers untouched (audit-resolved: `locations.country` is NOT NULL with eq-based dedup — null would break it). PR body documents the one storage edge: a profile with no city/state and only the AI-defaulted country previously created a generic "United States" location row; now creates none.

4. **Testability**: add `@panel` alias → `../chrome-extension/panel-app/src` in `careervine/vitest.config.ts` **and** a `@panel/*` paths entry in `careervine/tsconfig.json` (the `@ext` precedent skates by on `@ts-expect-error` because it's plain JS; this module is TS and should typecheck for real). New `careervine/src/__tests__/profile-format.test.ts` covering the ticket's decided test cases plus the date/duration/status helpers (fixed `now`).

5. **Verify & ship**: `npm run test` from `careervine/`; `npm run build` in `panel-app/` and commit the rebuilt bundle with source; PR titled `… (CAR-42)`.

## Acceptance criteria (from ticket)

- No location gains a country the source didn't contain (outside the documented state-name-collision tradeoff).
- US locations still normalize to "City, ST, USA"; 3-part US forms keep working.
- Helpers unit-tested from the careervine suite via `@panel`; `App.tsx` meaningfully smaller.
- Server behavior byte-identical except the documented no-location edge.
