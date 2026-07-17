# CAR-148 — Single-sourced extension wire contract with real validation, parity tests, analytics event-name parity

**Ticket:** CAR-148 (Straight A's / Phase 5, retires F11, F59, F34). Blocked-by CAR-138 (CI) — code+tests land here; the CI gate that runs them is CAR-138's.

## Problem

The extension↔webapp wire is hand-mirrored in three `ProfileData` declarations
(`api/contacts/import/route.ts`, `contacts/preview/page.tsx`, `panel-app/src/App.tsx`)
and `contactsImportSchema.profileData` is `z.record(z.string(), z.unknown())` — the
wire validates **nothing**. Create-path email insert skips the regex/length check the
update path enforces. Extension analytics event names are string literals with no
guard tying them to `AnalyticsEvents`. `@ext` isn't in the webapp tsconfig, forcing a
`@ts-expect-error`; the tsconfig `paths` coupling is undocumented.

## Key constraint that drives the architecture

`panel-app` builds **standalone** (vite, `moduleResolution: Node`, `include: ["src"]`,
no path aliases, **no `zod` dependency**), and `background.js` is a **classic MV3
service worker** (`"service_worker"` with no `"type":"module"`, so no ES `import`).
Therefore:

1. The panel **cannot import any file that imports zod** (it can't resolve `zod`'s
   types). So the single `ProfileData` **type** must live in a **zod-free, panel-reachable
   pure module**. The repo already shares panel→webapp pure modules via the existing
   `@panel` alias (`profile-format.ts`, `ai-failure.ts`, `rate-limit-copy.ts`). We follow
   that established direction.
2. `background.js` consumes the const module via `importScripts` (a classic-SW UMD file,
   mirroring `identify-sections.js`'s `module.exports` pattern) — no manifest change.

## Architecture

- **`chrome-extension/panel-app/src/lib/profile-contract.ts`** (NEW, pure TS, zod-free,
  React-free): the **single** `ProfileData` declaration + `ProfileExperience`,
  `ProfileEducation`, `ProfileLocation`. This is the one declaration `rg` will find.
- **`careervine/src/lib/extension-contract.ts`** (NEW): imports the pure type via
  `@panel/lib/profile-contract`, builds the real `profileDataSchema` (zod 4
  `z.looseObject` + `.default()` so unknown keys survive and partial payloads fill
  defaults — backward-compatible — while malformed known fields reject), and exports the
  four extension-endpoint request schemas + `z.infer` types + the parse-profile OpenAI
  JSON schema. Re-exports `ProfileData` for webapp consumers.
- A careervine parity test asserts `z.infer<typeof profileDataSchema>` ≡ `ProfileData`,
  so schema/type drift on either side turns CI red.

### Why `z.looseObject` + `.default()`

The shipped extension POSTs a superset (`first_name`, `id` on rows, `photo_url`, …).
`looseObject` keeps unknown keys (backward-compat, FIELD CONTRACT). `.default([])`/
`.default({})`/`.default(null)` on `experience`/`education`/`suggested_tags`/`location`/
`contact_status` make the **output** type carry them as present — matching the panel's
post-`enrichProfile` invariants — so the panel uses the wire type with no guard churn,
while the **input** stays lenient. Malformed known fields (e.g. `experience:"x"`,
`location:"USA"`) reject → 400 at the wire.

## Scope / file-by-file

### 1. Single-sourced type + validated wire
- NEW `panel-app/src/lib/profile-contract.ts` — canonical types (documented).
- NEW `careervine/src/lib/extension-contract.ts` — `profileDataSchema`,
  `extensionImportSchema`, `extensionCheckDuplicateSchema`, `extensionParseProfileSchema`,
  `extensionPingSchema`, their `z.infer` types, `parseProfileJsonSchema`, re-export
  `ProfileData`.
- `api-schemas.ts` — `contactsImportSchema` = `extensionImportSchema` (profileData now
  `profileDataSchema`); re-export the three extension schemas from the contract so
  existing `@/lib/api-schemas` importers/tests are unaffected.
- `api/contacts/import/route.ts` — delete local `ProfileData`/`ProfileLocation`/
  `ProfileExperience`/`ProfileEducation`; import from contract; drop the
  `body as { profileData: ProfileData }` cast; FIELD CONTRACT header.
- `import-helpers.ts` — type `buildContactData`/`buildUpdateData` against `ProfileData`
  (drop `any`); add shared `isValidContactEmail`.
- `contacts/preview/page.tsx` — delete local `ProfileData`; import from contract.
- `panel-app/src/App.tsx` — delete local `ProfileData`; `import type { ProfileData }`
  from `./lib/profile-contract`.

### 2. Email parity + FIELD CONTRACT headers
- `import/route.ts` — lift create-path email insert to the update path's check via the
  shared `isValidContactEmail` (regex + 320 cap) so both paths reject identically.
- FIELD CONTRACT header on all four extension routes: import, parse-profile,
  check-duplicate, ping. `parse-profile` imports `parseProfileJsonSchema` from the contract.

### 3. F59 — analytics event-name const module
- NEW `chrome-extension/src/analytics-events.js` — UMD const `EXTENSION_ANALYTICS_EVENTS`
  = { PROFILE_SCRAPED, EXTENSION_LOGGED_IN, EXTENSION_INSTALLED } on the worker global +
  `module.exports`. NEW `analytics-events.d.ts` (literal types) for the webapp typecheck.
- `background.js` — `importScripts('../analytics-events.js')`; use the constants at the
  three `trackEvent` sites.
- NEW test via `@ext/analytics-events` asserts each name is a key of `AnalyticsEvents`
  (renaming an event without updating the const module → red).

### 4. F34 — tsconfig coupling + `@ext`
- `careervine/tsconfig.json` — add `"@ext/*"` path; coupling comment above the `paths`
  block.
- `careervine-mcp/tsconfig.json` — coupling comment above its `paths` block.
- NEW `chrome-extension/src/content/identify-sections.d.ts`; drop the `@ts-expect-error`
  in `identify-sections.test.ts`.

### Tests (careervine vitest)
- `extension-contract.test.ts` — wire validation (malformed rejected, defaults filled,
  unknown keys survive), type parity (`z.infer` ≡ `ProfileData`), parse-profile JSON
  schema ↔ zod field correspondence.
- Route test: malformed `profileData` → **400** through the real `POST` handler.
- `import-helpers` email test — create/update reject the same invalid emails.
- `extension-parity.test.ts` — `deriveContactStatus` case table (webapp vs `@panel`);
  `AI_FAILURE_COPY` parity (same code set + surface-invariant fields; body/ctaLabel
  intentionally differ for `ai_trial_expired` because the panel CTA is a link).
- `extension-analytics-parity.test.ts` — event names ⊂ `AnalyticsEvents`.

## Verification
`npm run test` + `npm run build` (careervine), `tsc --noEmit` (panel-app), careervine-mcp
typecheck. Then PR → `/deep-review-pr` → fix every verified finding + nit → re-verify.

## Out of scope / notes
- No manifest change (classic SW kept). No new panel deps (pure type import only).
- No user-facing copy change → no docs.careervine.app update (rule 34) and no em-dash
  risk (rule 35).
- Exit criteria: `rg 'interface ProfileData|type ProfileData'` == 1; malformed payload
  400 in a route test; create rejects the emails update rejects; parity tests red on
  drift; both `paths` blocks carry coupling comments; `@ext` `@ts-expect-error` empty;
  four routes carry the FIELD CONTRACT header.
