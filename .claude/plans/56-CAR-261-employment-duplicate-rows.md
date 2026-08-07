# CAR-261 — contact_companies gets a uniqueness constraint that fires

## Root cause

One unique index, unchanged since init (`20260201214637_init.sql:191`):

```sql
CREATE UNIQUE INDEX contact_companies_unique_idx
  ON contact_companies (contact_id, company_id, start_date);
```

`start_date` is a date column the app never writes; it populates `start_month`
(text) instead. **Verified against production: 0 of 88,204 rows carry a non-null
`start_date`.** Postgres treats NULLs as distinct, so `(contact_id, company_id, NULL)`
has never collided with itself. The table has had **no effective uniqueness, ever**.

## Blast radius (production, 2026-08-07)

70 surplus rows / 65 groups / 61 contacts, out of 88,204 (0.08%). **Every account**,
not one: 14 surplus rows each for the four large accounts, 12 and 2 for the others.
Worst multiplicity 3.

**61 of the 65 groups have fully contiguous row ids** (67426/67427/67428, 5091/5092,
72/73). Contiguous ids mean one INSERT wrote every copy, so this is intra-payload
duplication, not drift across re-imports. That points at `bulk-import.ts`'s CREATE
branch, which mapped the actor payload 1:1 while the sibling merge branch deduped.
The other 4 groups are spread across id ranges: the genuine cross-run miss.

## The key choice, and the mistake it avoids

The app's `employmentKey()` omits `end_month` on purpose: it is the MATCHING key, and
end_month changes the day someone leaves ("Present" becomes "Oct 2025"), which must
update the row rather than insert a second one.

Keying uniqueness the same way was measured and **would have deleted real history**:

| contact | company | title | end months |
| --- | --- | --- | --- |
| Cody Wang | AWS | Software Development Engineer Intern | Aug 2015 **and** Aug 2016 |
| Kirk Smith | Revetize | VP corporate partnerships | Sep 2020 **and** Jan 2022 |

Two internships, two stints. 15 such groups exist. So:

- **Database** enforces EXACT duplicates only: `(contact_id, company_id, title,
  start_month, end_month) NULLS NOT DISTINCT`. Deletes 70 rows, destroys nothing.
- **Application** keeps semantic identity, where it can reconcile drift instead of
  destroying a row it cannot reason about.

`NULLS NOT DISTINCT` is load-bearing: all three optional columns are nullable, and
without it the new index would be exactly as inert as the old one.

## Changes

**Migration** `20260808020000_car261_contact_companies_real_unique_key.sql` — collapse
duplicates keeping the lowest id, drop the dead index, create the real one, assert zero
groups survive. Safe on two verified facts: nothing foreign-keys to
`contact_companies.id`, and within every duplicate group `location_id`,
`workplace_type`, `is_current` and `source` are identical.

**`scrape-merge.ts`** — new `employmentRowKey` (identity) beside `employmentKey`
(matching), each documented against the other. The incoming dedupe switches to the
identity key, and `incomingByKey` becomes `Map<matchKey, rows[]>`: bucket[0] is the
match candidate, siblings are distinct stints that fall through to Pass D inserts.

> The first attempt keyed the whole map by the identity key. That silently broke Pass A,
> which looks up by the matching key, so every drifted row became an insert. Caught by
> the new "still matches an existing row whose end_month drifted" test, which is why it
> is in the suite.

**`bulk-import.ts`** — the CREATE branch dedupes its payload (the actual source of 61/65).
**`bundle-fast-apply.ts`** — same dedupe the education loop beside it already had.
**`api/contacts/import/route.ts`** — three fixes: the dedupe key widens from
`company_id:title` to the full natural key; `relSet` is added to inside the loop so
intra-payload repeats are caught; and the rollback restore's DELETE error is checked
(discarding it could double every extension row) with the restore made collision-tolerant.
**`data/contacts.ts`** — `addCompanyToContact` upserts with `ignoreDuplicates`, so
re-adding a role is a no-op rather than a 23505. Returns nothing: all three callers
already discarded the row.

## Verification

- ON CONFLICT inference against a `NULLS NOT DISTINCT` index proven on real Postgres in
  a rollback: all-NULL duplicates collapse, and two rows differing only by end_month
  both survive.
- Migration executed against production inside `BEGIN … ROLLBACK` (rule 32): 88,204 to
  88,134, exactly the 70 measured surplus rows, assertion passed.
- `npm run test` 3862 passed, `check:conventions` clean, `test:integration` 54 passed
  **after applying the migration to the local DB** — the first integration run passed
  against the OLD index and proved nothing.
- Integration falsified: making two fixture roles collide fails with
  `duplicate key value violates unique constraint "contact_companies_natural_key_idx"`.

## Deploy order

The upsert paths need the index to exist (ON CONFLICT requires a matching constraint),
so **the migration applies BEFORE the merge**, per rule 42's inversion.
