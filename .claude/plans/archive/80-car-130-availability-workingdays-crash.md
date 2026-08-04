# CAR-130 — Settings Availability crashes (workingDays stripped)

## Problem

Settings → Availability throws a client-side exception.

## Root cause

`calendarAvailabilityProfileSchema` only models the legacy flat profile (`days`, `windowStart`, …). Settings and the availability picker save `{ workingDays: [...] }`. Zod strips unknown keys → DB stores `{}` → UI calls `.workingDays.map` on undefined and crashes.

## Fix

1. Accept `workingDays` day configs in the schema (keep legacy keys optional).
2. Normalize/fallback in AvailabilitySection when stored profile lacks `workingDays`.
3. Schema + normalize unit tests.
4. Clear empty `{}` profiles in prod if present (optional data repair; UI harden covers it).
