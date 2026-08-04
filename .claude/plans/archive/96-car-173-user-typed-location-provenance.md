# CAR-173: Stop rewriting hand-typed cities (provenance-aware metro aliasing)

## Problem

`findOrCreateLocation` (the CAR-155 chokepoint) runs `normalizeParsedLocation`, which unconditionally applies `METRO_ALIASES` — a scrape-oriented map that collapses suburbs onto metro cities. Hand-typed input from the Add/Edit Contact forms now flows through the same chokepoint, so a user who types "Cambridge, Massachusetts" silently gets "Boston, Massachusetts" stored (7 of 10 real cities tested were rewritten). The CAR-155 guard only blocks aliases that *contradict* known state/country; a matching state collapses by design.

## Design: explicit provenance, per the ticket's suggested fix

Add `type LocationSource = "scraped" | "user"` and thread it through the normalizer and the chokepoint.

**Alias map split** (in `location-normalizer.ts`), by what the key actually denotes:

- `CITY_SYNONYMS` — same city under another spelling (`nyc`, `new york city` → New York). Provenance-independent canonicalization; applies to **both** sources. (Without this, a user typing "NYC" would store title-cased "Nyc".)
- `METRO_COLLAPSES` — everything else: metro phrases ("san francisco bay area", "silicon slopes", …) and real-suburb collapses (cambridge, brooklyn, santa monica, st. paul, la jolla, …). Applies to **scraped only**. For user input, what was typed is what is stored (title-cased, state/country canonicalized).
- For scraped input the union is byte-identical to today's `METRO_ALIASES` — zero behavior change on the import/bulk/bundle pipelines.
- `KNOWN_METRO_CITIES` is identity-mapped on city name (used to infer state for "Greater Seattle Area" etc.) — stays source-independent.

**Signatures:**

- `normalizeLocation(input, opts?: { source?: LocationSource })` and `normalizeParsedLocation(parsed, opts?)` — default `"scraped"` (documented: these are the scrape pipeline's normalizers; every existing direct caller is a scrape path or a match-key computation against scrape-normalized rows).
- `applyMetroAlias` + the two direct map lookups become source-aware.
- `parseManualLocation` hardcodes `source: "user"` — it is documented as the manually-typed-input parser (fixes the same bug on manual work-experience locations via `resolveManualCompanyLocation`).
- `findOrCreateLocation` (`src/lib/data/locations.ts`) — `source` becomes **required** in opts: the chokepoint forces every locations-row writer to declare provenance, so a future user-facing caller can't silently inherit scrape collapsing.

**Call-site classification:**

| Caller | Source |
| -- | -- |
| `contacts/page.tsx` (Add form), `contact-info-header.tsx`, `contact-edit-modal.tsx` (Edit) | `user` |
| `mcp/lib/db.ts` `createContactFull` (agent relays what the user asserted) | `user` |
| `data/contacts.ts` `resolveManualCompanyLocation` | `user` |
| `company-helpers.ts` wrapper (serves import route, backfill, bundle-publish, bundle-resolve, bulk-import only) | hardcodes `scraped` |
| `import-helpers.ts` | `scraped` |

No retroactive repair of previously-saved contacts — the original typed value was never persisted (per ticket).

## Tests

- Regression suite in `location-normalizer.test.ts`: the ticket's full measured table (Cambridge/MA, Brooklyn/NY, Manhattan/NY, Santa Monica, Hollywood, La Jolla, St. Paul + correct Manhattan/KS, Provo/UT) through `normalizeParsedLocation` with `source: "user"` → stored exactly as typed; same inputs default/scraped → still collapse (pins both behaviors).
- `parseManualLocation`: "Cambridge, MA" stays Cambridge; "Greater Seattle Area" still resolves to Seattle (KNOWN_METRO_CITIES identity); NYC synonym still canonicalizes.
- Chokepoint test: `findOrCreateLocation` with `source: "user"` probes for the typed city, with `source: "scraped"` probes for the collapsed metro.
- Update any existing tests broken by the now-required `source` opt.

## Verification

`npm run test` from `careervine/`, `npm run build`, then PR. No migrations, no docs-page/privacy changes (neither documents metro collapsing — checked).
