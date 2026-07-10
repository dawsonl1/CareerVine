# CAR-44 — Merge split company rows (hand-named vs LinkedIn-identified)

**Status of the ticket's claims after a full audit (3 agents: schema, code paths, production data — 2026-07-10):**

## What the audit confirmed, corrected, and added

### Confirmed
- **Root cause is verified and complete.** Every split found is explained by the ticket's diagnosis: the target-list bulk import (`careervine/src/app/api/target-companies/bulk-import/route.ts:43`) never passes `linkedin_company_id` (the request schema has no such field), so hand-named rows have no LinkedIn identity; the Apify scrape ingest resolves employers by a strict identity chain and lands contacts on separate identity-bearing rows when names diverge. **Zero counterexamples**: all 158 of Dawson's zero-contact target companies have NULL `linkedin_company_id` AND NULL `universal_name` — there is no case of an identity-bearing row sitting empty while a sibling holds contacts.
- **8 of 99 APM-bundle companies have zero contacts** (scoped to Dawson's contacts; globally 7 — HealthTree Foundation id 60 has one contact from the `pitcherdawson12@gmail.com` alt account). All 8 pairs in the ticket verified, siblings confirmed by scrape-slug evidence in `contacts.import_source`.
- The non-bundle split estimate ("20–25") holds: **18 high-confidence pairs + 9 judgment pairs ≈ 26–27 total** (full table below).
- The resolver never fuzzy-matches: `findOrCreateCompany` (`careervine/src/lib/company-helpers.ts:127-245`) matches `linkedin_company_id` → `linkedin_url` (exact, slash-normalized) → `universal_name` (exact ilike) → `name` (exact ilike), then inserts. All escaped, never fuzzy.

### Corrected (numbers drifted / claims wrong)
- **168 of 329** targeted rows lack `linkedin_company_id` (ticket said 172; a few were claimed/backfilled by scrapes since). 329 is exact. All 168 also lack `universal_name`.
- Sibling contact counts drifted upward (HPE 37→64, HealthTree 11→13, Atonom 13→17). Cosmetic.
- **The ticket's "follow the pattern of `20260708113000_merge_duplicate_companies_by_linkedin_identity.sql`" is unsafe as written**, for four reasons:
  1. That migration's `ON CONFLICT (user_id, company_id)` on `target_companies` **no longer resolves** — `20260710070000_pipeline_company_page.sql:24-33` dropped that constraint and replaced it with two *partial* unique indexes keyed on `location_id` (NULL vs NOT NULL). A verbatim copy fails `db push`.
  2. Its survivor rule is `MIN(id)` — **inverted for our case**. Hand-named rows are usually older (lower id), so MIN(id) would keep the *wrong* row. Survivor must be chosen as "the row holding the contacts / LinkedIn identity," per explicit pair.
  3. Its blind `UPDATE contact_companies SET company_id = ...` can violate `UNIQUE(contact_id, company_id, start_date)` (`20260201214637_init.sql:191`) when a contact has employment rows at both loser and survivor. The old migration's "no uniqueness conflict" comment is factually wrong.
  4. Its matching logic (shared LinkedIn identity) **cannot produce our pairs at all** — by definition these pairs share no identity key. CAR-44's merge list must be an explicit, human-verified pair list, not computed matching.
- **The ticket's FK list is incomplete.** It names `target_companies`, `bundle_companies`, `company_locations`, `target_company_notes`. Missing direct FKs: **`contact_companies`** (NO ACTION — blocks delete), **`user_companies`** (NO ACTION — blocks delete), **`discovery_candidates`** (CASCADE — rows silently vanish), **`scrape_runs.company_id`** (NO ACTION — blocks delete). Missing indirect: **`pipeline_cycles` (+ 4 child tables) hang off `target_companies.id` with ON DELETE CASCADE** — deleting loser target rows the old way would cascade-destroy recruiting-pipeline data. `target_companies` also gained columns the old column list omits: `location_id`, `is_targeted`, `active_cycle`, `last_discovery_at`.

### New facts the ticket didn't know
- **`companies` is a global shared table and the merge is multi-tenant.** A second live subscriber (`jordanfaust15@gmail.com`) received a bundle apply *today* (post-CAR-47) and his ~700 contacts attach to the same survivor rows (Dell 573, Lucid 1437, Hewlett-Packard 574, Atonom 956, HealthTree 3419). Merges must not disturb those rows' ids. Good news: apply/sync never caches company ids — every apply re-resolves employers by LinkedIn identity from the payload (`bundle-sync.ts:439` → `bulk-import.ts:295`) — so repointing/deleting *loser* rows is safe for subscribers.
- Current production references to the ~34 loser rows are almost entirely Dawson's: 33 `target_companies`, 8 `bundle_companies`, 9 `company_locations`, **1 foreign row** (`contact_companies` of the alt account on company 60). Zero `discovery_candidates` / `scrape_runs` / `user_companies` references — but the migration must still handle them defensively (data moves between plan-time and run-time).
- `bundle_companies.company_id` is `ON DELETE CASCADE` with `UNIQUE(bundle_id, company_id)`: deleting losers without repointing silently shrinks the bundle's browse list and strands `data_bundles.company_count`. If a bundle ever contains both halves of a pair, upsert-then-delete shrinks the count — so the migration recounts `company_count` at the end.
- `companies.name` is **globally UNIQUE** (`init.sql:45`) — survivor renames must happen *after* the loser row is deleted, never before.
- In two pairs the *survivor* also lacks LinkedIn identity (Digital Harbor 6095, NICE inContact 6497) — identity-based prevention alone would not have prevented those.

---

## Merge list

Survivor = the row holding the contacts (LinkedIn-canonical). All ids verified in production 2026-07-10.

### A. Bundle pairs (fixes the 8 zero-contact bundle companies)

| # | Loser (hand-named, identity-less) | Survivor | Rename survivor? |
|---|---|---|---|
| 1 | 297 Hewlett Packard Enterprise (HPE) | 574 Hewlett-Packard (li 1025) | → "Hewlett Packard Enterprise" |
| 2 | 60 HealthTree Foundation | 3419 HealthTree (li 35547412) | → "HealthTree Foundation" |
| 3 | 215 Western Governors University (WGU) | 4967 Western Governors University (li 106103185) | keep |
| 4 | 344 Signals | 956 Atonom (li 12655753) | keep (rebrand — Signals.ai is now Atonom) |
| 5 | 222 Lucid Software | 1437 Lucid Software Inc. (li 1214453) | → "Lucid Software" |
| 6 | 273 Dell Technologies | 573 Dell (li 15088102) | → "Dell Technologies" |
| 7 | 325 NiCE | 6497 NICE inContact (li NULL) | keep — see decision D8 |
| 8 | 7598 Zynga (RPM/APM program) | 163 Zynga (li 167907) | keep (7598 is bundle-only, not targeted) |

### B. Non-bundle high-confidence pairs (18)

209 Instructure (Canvas LMS)→740 Instructure, Inc. · 359 Traeger→3211 Traeger Pellet Grills, LLC · 357 Xactware / Verisk→1618 Xactware · 250 SalesRabbit→2364 Sales Rabbit, Inc. · 459 Rubrik→4679 Rubrik, Inc. · 277 Bloomberg→1026 Bloomberg LP · 232 doTERRA International→1172 doTERRA International LLC · 300 Overstock.com (Beyond, Inc.)→571 Overstock.com · 363 Franklin Covey→3028 FranklinCovey · 203 Zoom→3314 Zoom Video Communications · 246 Merit Medical Systems→1286 Merit Medical Systems, Inc. · 199 X (Twitter)→1180 Twitter · 263 Reddit→7195 Reddit, Inc. · 251 Digital Harbor, Inc.→6095 Digital Harbor · 360 Backcountry→1666 Backcountry.com · 372 Angel Studios→3439 Angel (un `angel-studios-page` confirms) · 219 Veras→1224 Veras (Formerly Jobwise) · 224 Bed Bath & Beyond (Utah digital HQ)→2177 Bed Bath & Beyond.

Rename judgment per pair at implementation time: prefer the hand-written display name when it's cleaner (strip legal suffixes), keep LinkedIn-canonical when the hand name is stale (X (Twitter) → keep "Twitter"... or "X"? default: LinkedIn-canonical).

### C. Judgment pairs — need Dawson's call (recommendations attached)

These are subsidiary/parent/acquisition pairs where "merge" really means "re-point the target at the row that got scraped." The alternative is leaving the target empty until a company-specific scrape runs.

| # | Pair | Recommendation |
|---|---|---|
| D1 | 405 Verifi (Visa) → 154 Visa (34 contacts) | **Merge into Visa** — the scrape ran slug `visa`; the data is Visa-wide |
| D2 | 465 Duo Security (Cisco) → 723 Cisco (16) | **Merge into Cisco** — same reasoning |
| D3 | 390 Vizio (Walmart) → 161 Walmart (30) | **Merge into Walmart** — same reasoning |
| D4 | 424 Buildium (RealPage) → 5776 RealPage, Inc. (1) | **Merge** |
| D5 | 193 TikTok / ByteDance → 854 ByteDance (1) | **Merge** |
| D6 | 236 BioFire / bioMérieux → 1092 bioMérieux (3) | **Merge** |
| D7 | 296 Amazon / AWS → 61 Amazon (73 total w/ 68 AWS) | **Re-point target at 61 Amazon only.** Do NOT merge Amazon and AWS rows together — they're distinct entities both holding contacts |
| D8 | 325 NiCE → 6497 NICE inContact (1 contact, survivor has no li id) | **Merge** (inContact is NICE's Utah arm — matches Dawson's geography); backfill identity later if sourced |
| D9 | 196 Warner Bros. Discovery → 4367 Warner Bros. (1); 197 Warner Music Group → 6116 Warner/Chappell (1) | **Leave both** — genuinely different entities, 1 stale contact each, not worth a wrong merge |

Rejected false positives the fuzzy pass surfaced (do NOT merge): Cloudflare↛Lightstream, SentinelOne↛Sentinel(vigilife), Sierra↛Sierra Nevada Corp, Ripple↛Ripple Neuro, Tinder↛MATCHA, Block↛BlockFi.

The remaining ~128 zero-contact targets have no sibling anywhere — genuinely unscraped (tranche 1 covered 69 of 329 slugs). Out of scope per the ticket.

---

## Implementation

### 1. Migration `2026XXXXXXXXXX_merge_split_company_rows.sql`

One transaction. Seed an explicit pair table — **hardcoded (loser_id, survivor_id) pairs guarded by name**, so the migration no-ops harmlessly on any environment where ids don't line up:

```sql
CREATE TEMP TABLE pair(loser_id int, loser_name text, survivor_id int, survivor_name text, new_name text);
INSERT INTO pair VALUES (297, 'Hewlett Packard Enterprise (HPE)', 574, 'Hewlett-Packard', 'Hewlett Packard Enterprise'), ...;
-- keep only rows where BOTH ids exist with the expected names
DELETE FROM pair p WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id=p.loser_id AND c.name=p.loser_name)
                     OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id=p.survivor_id AND c.name=p.survivor_name);
```

Then per FK table, in this order (each step handles its unique constraint; NO blind updates):

1. **`contact_companies`** — delete loser rows that collide with an existing survivor row on `(contact_id, company_id, start_date)`, then `UPDATE` the rest. (Fixes the latent bug in the 20260708 pattern; also covers the alt-account row on company 60.)
2. **`user_companies`** — same collide-then-update pattern on `(user_id, company_id, start_date)`. (Never handled by the prior migration — latent gap.)
3. **`company_locations`** — insert survivor-keyed copies `ON CONFLICT (company_id, location_id) DO NOTHING`, delete loser rows.
4. **`bundle_companies`** — insert survivor-keyed copies `ON CONFLICT (bundle_id, company_id) DO NOTHING`, delete loser rows; recount `data_bundles.company_count` for affected bundles at the end.
5. **`discovery_candidates`** — plain `UPDATE company_id` (its unique key is `(user_id, linkedin_url)`, unaffected).
6. **`scrape_runs`** — `UPDATE company_id`, but first cancel/skip any *pending discovery* loser run that would collide with the partial unique `(user_id, company_id) WHERE status='pending' AND mode='discovery'`. (Zero rows today; defensive.)
7. **`target_companies`** — the delicate one:
   - Group loser+survivor rows per `(user_id, survivor_company_id, location_id)`; merge fields with the prior migration's COALESCE/status-ladder semantics, **including the new columns** `location_id`, `is_targeted`, `active_cycle`, `last_discovery_at`.
   - Two upsert passes matching the two partial indexes: `ON CONFLICT (user_id, company_id) WHERE location_id IS NULL` and `ON CONFLICT (user_id, company_id, location_id) WHERE location_id IS NOT NULL`.
   - **Before deleting loser `target_companies` rows, repoint their children**: `target_company_notes.target_company_id` AND `pipeline_cycles.target_company_id` to the surviving target row. (Skipping this cascade-deletes pipeline cycles/programs/applications/interviews.)
8. **Delete loser `companies` rows** (all FKs now repointed, so NO ACTION FKs won't block).
9. **Rename survivors** per the `new_name` column — only now, after losers are gone (`companies.name` is UNIQUE).
10. Identity backfill: survivors already carry LinkedIn identity except 6095/6497 — nothing to backfill from the losers (they're identity-less by definition). No-op in practice; skip rather than pretend.

Post-migration `DO` block asserts: zero loser ids remain anywhere; every APM `bundle_companies` row (minus D9 leave-outs) has ≥1 contact.

### 2. Prevention (code, same PR)

All company creation funnels through `findOrCreateCompany` (`company-helpers.ts`) — one home for the fix:

- **(a) Normalized-name matching in the resolver's step 4**: normalize (lowercase, trim, collapse whitespace, strip punctuation + legal suffixes `inc/llc/ltd/corp/co`) and match on that instead of raw exact ilike. Safe-strict only — "Lucid Software" ↔ "Lucid Software Inc." matches; "Zoom" ↔ "Zoom Video Communications" deliberately does not (token-fuzzy matching is how you merge Verifi into Visa by accident). Existing claim logic (`claimCompanyRow`) then backfills identity when the caller has one, which kills the recurrence loop in both directions.
- **(b) Warn on identity-less creates**: when inserting a row with no `linkedin_company_id`/`linkedin_url`/`universal_name`, run a cheap similarity probe (normalized-prefix / parenthetical / slash-token) against existing names; on a hit, still create but emit a structured warning (server log + PostHog event) and include a `possibleDuplicateOf` field in the bulk-import API response so imports surface it.
- **(c) Let the target-list import carry identity**: add optional `linkedin_company_id` / `universal_name` to the bulk-import schema (`api-schemas.ts:234-248`) and thread them into `findOrCreateCompany`, so a future re-import of the APM sheet (which has LinkedIn URLs/slugs) creates identity-bearing rows.
- Tests (Vitest, from `careervine/`): normalization helper unit tests incl. the false-positive list above as negative cases; resolver match-precedence tests; bulk-import schema test.

### 3. Out of scope (per ticket)
- The ~128 genuinely unscraped targets — no ticket wanted.
- Merging the Amazon↔AWS or HP↔"HP" (id 847) sibling *survivor* rows with each other — distinct entities.
- Backfilling identity on the remaining ~135 identity-less targeted rows not involved in splits. Worth a follow-up before scrape tranche 2 (prevention (a)+(c) reduce but don't eliminate re-split risk); flag to Dawson rather than smuggle into this PR.

## Verification
1. `supabase db push --dry-run` review, then apply on merge (rule 27); migration's own assertions must pass.
2. Production checks after apply: 99/99 (or adjusted count) APM bundle companies show contacts; zero orphaned FK rows; Jordan's subscription untouched (contact counts on survivor rows unchanged); `data_bundles.company_count` correct.
3. `npm run test` green from `careervine/`.
4. Company pages for HPE/HealthTree/WGU/Signals→Atonom spot-checked via the app.
