# CAR-218 — Stop the contact edit modal deleting education

## Problem

`contact-edit-modal.tsx` holds ONE set of education fields (`school_name`, `degree`,
`field_of_study`) in `formData`, seeded from a single `contact_schools` row, and its
save path removes every school on **both** branches:

```js
if (formData.school_name.trim()) {
  await removeSchoolsFromContact(contact.id);   // all of them
  ...addSchoolToContact(one row)
} else {
  await removeSchoolsFromContact(contact.id);   // all of them, none back
}
```

So a contact with a bachelor's and an MBA silently loses one the first time anyone
opens the modal and saves, even without touching the education fields. **268 of 621
sampled production contacts (43%) have more than one school.** The only recovery is a
re-scrape.

Second, quieter loss on the same path: `addSchoolToContact` is called with
`start_year: null, end_year: null`, so a save also wipes the years scraped for the
school it keeps. Those years are what `sortEducation` ranks on (CAR-216), and they
feed the MCP dossier and both AI context builders.

## Approach

Education becomes a repeating list, mirroring the Work experience section directly
above it. That is the option that makes the modal able to edit everything the profile
displays, rather than containing the damage.

- `schools: SchoolEntry[]` replaces the three `formData` keys, where
  `SchoolEntry = { school_name, degree, field_of_study, start_year, end_year }`.
- Seeded through `sortEducation`, so the modal lists degrees in the same order the
  profile card shows them.
- Save mirrors the companies loop: remove-all, then insert each non-empty entry.
- **Years are carried on the entry and written back unchanged.** They are not exposed
  as inputs: the profile card does not display them, and two more boxes per row is
  clutter for a value nobody edits (rule 5). Preserving them is what stops the
  second loss; a newly added row simply has nulls.
- The existing disclosure stays. With no education and a non-student contact the
  section is still a single "Add education" button; clicking it reveals the list and
  seeds one empty row.

`serializeForm`/`FormSnapshot` (the CAR-198 unsaved-changes guard) gain `schools`, so
adding, editing or removing a degree is an unsaved change like any other.

## Files

- `careervine/src/components/contacts/contact-edit-modal.tsx` — state, populate, save,
  the status-toggle's `hasEd` check, and the Education JSX
- `careervine/src/__tests__/contact-edit-dirty-check.test.ts` — snapshot shape + cases
  for the new field
- `careervine/src/__tests__/contact-edit-education.test.tsx` (new) — the actual bug:
  open a two-school contact, save without touching education, assert BOTH survive with
  their years intact

## Verification

`npm run test`, `npm run typecheck`, `npm run lint`, `npm run check:conventions`,
`npm run check:ui-events`, `npm run build`. Falsify the new test against the old
single-school save path before keeping it.
