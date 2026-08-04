# CAR-216 — Order profile experience and education chronologically

## Problem

`ContactExperienceCard` renders `contact.contact_companies` in raw array order, and
`getContactById` embeds the join with no ordering. Postgres serves the FK lookup from
`contact_companies_unique_idx (contact_id, company_id, start_date)`, so rows arrive in
**ascending `company_id`** — the order the app first created that company anywhere in
the account. Verified on production: `company_id` ascending in 6/6 multi-role contacts,
row `id` ascending in 1/6. Education matches, via `contact_schools_unique_idx`.

Consequences: companies already in the DB before this contact was scraped float to the
top; a later-captured job at a company new to the account renders last; the same array
feeds `.find(cc => cc.is_current)` on the profile header, the contacts list and MCP, so
multi-role contacts show an arbitrary "current" role. And the three surfaces that *do*
sort share a comparator whose tiebreak is `localeCompare` over `"Mon YYYY"` text, which
orders by month name: on real values it yields Mar 2021, Jul 2021, Jul 2014, Jan 2018,
2023, 2017.

## Data shapes (surveyed on 1000 production rows)

`start_month` / `end_month` are TEXT, and real values are messier than the schema
comment claims:

| Shape | Count | Note |
| --- | --- | --- |
| `Mon YYYY` | 847 | dominant, the documented shape |
| `YYYY` | 66 | bare year, no month |
| `Present` | 182 (end only) | ongoing marker |
| month name, no year (`Jul`, `June`) | ~40 | user-typed, `source='manual'` |
| truncated (`December 202`) | ~11 | user-typed |
| null | 8 | |

`start_date` (the real `date` column) is populated on **0** of 1000 rows, so it is not a
usable sort key and the admin route that sorts on it is sorting on nothing.

## Approach

One shared module, `careervine/src/lib/experience-order.ts`, used by every surface:

- `parseExperienceMonth(text)` → sortable `year*100 + month` (month `0` when the text
  carries only a year), or `null` when no 4-digit year is present. Accepts `Mon YYYY`,
  `Month YYYY`, `YYYY`, `YYYY-MM`, `M/YYYY`, and tolerates case, extra whitespace and a
  trailing period. `Present`/`Current` parse as `null` — they are not a date.
- `sortExperiences(rows)` → current first, then newest start first, undated last.
  A row with no parseable start falls back to its **end** month for ranking, so a
  half-dated row still lands near its real place instead of at the bottom. Past-role
  ties break on end month descending, then on input index, so the comparator is a
  total order and the output no longer depends on the query planner.
- `primaryCurrentRole(rows)` → the newest-starting current role, replacing every
  `.find(cc => cc.is_current)`.
- `sortEducation(rows)` → newest first on `end_year`, then `start_year`, undated last.

Decorate-sort-undecorate so each row is parsed once.

## Files

New:
- `careervine/src/lib/experience-order.ts`
- `careervine/src/__tests__/experience-order.test.ts` (parser shapes drawn from the
  production survey above, ordering, ties, stability)
- `careervine/src/__tests__/contact-experience-card.test.tsx` (renders the card and
  asserts the visible order, which is the actual bug)

Changed:
- `careervine/src/components/contacts/contact-experience-card.tsx` — sort both lists
- `careervine/src/components/contacts/contact-profile-card.tsx` — `primaryCurrentRole`
- `careervine/src/app/contacts/page.tsx` — three `.find(is_current)` sites + the
  companies list on the contact card
- `careervine/src/components/contacts/contact-edit-modal.tsx` — same order when editing
- `careervine/src/components/companies/person-modal.tsx` — replace the comparator
- `careervine/src/lib/company-queries.ts` — replace the comparator
- `careervine/src/mcp/lib/dossier.ts` — replace the comparator + current-role pick
- `careervine/src/mcp/tools/contacts.ts` — current-role pick
- `careervine/src/app/api/admin/users/[id]/contacts/route.ts` — drop the `start_date`
  sort that sorts on an always-null column; select the month columns and use the helper
- `careervine/src/lib/data/contacts.ts` — explicit embed ordering on `getContactById`
  so the input to the sort is deterministic rather than plan-dependent

## Out of scope, deliberately

- The ~50 user-typed rows with a month but no year stay unorderable by start; the helper
  falls back to end month and otherwise sorts them last. Fixing the free-text month
  inputs that let them in is a separate UX change.
- No `position`/`sort_order` column. LinkedIn's own DOM order encodes a primary role we
  do not store, but capturing it needs a migration plus extension and import changes and
  would only apply to newly scraped contacts.

## Verification

`npm run test`, `npm run build`, `npm run check:conventions`, `npm run lint` from
`careervine/`. Spot-check the ordering helper against the real contact 114 payload used
in the investigation.
