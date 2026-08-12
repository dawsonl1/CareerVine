# CAR-279 — One primary email per contact

## The invariant

**A contact that has any `contact_emails` rows has exactly one with `is_primary = true`.**

Nothing enforces that today, and `is_primary` is what the product actually sends to:

| Consumer | Behavior with no primary |
| --- | --- |
| `mcp/lib/email-policy.ts:96` `resolveRecipient` | falls back to `usable[0]` — sends to an arbitrary address |
| `lib/company-queries.ts:2182` outreach queue | falls back to first row seen |
| `components/contacts/contact-profile-card.tsx:76` | displays the first row |
| `app/api/gmail/ai-followups/generate/route.ts:102` | `.eq("is_primary", true)` with **no fallback** — the contact silently gets **no generated follow-up** |
| `app/api/contacts/search/route.ts:30`, admin roster | first row |

So "no primary" is not cosmetic: it is a contact the follow-up generator drops, and a send that goes wherever the row order lands.

## The three defects Dawson reported

1. **Extension re-add never promotes.** `updateExistingContact` (`app/api/contacts/import/route.ts:274-285`) inserts a hand-typed address with `is_primary: !hasPrimary`. Re-saving someone with a better address files it as *secondary*; outreach keeps using the old one.
2. **Deleting the primary leaves zero primaries.** The edit modal (`contact-edit-modal.tsx:314-319`) and profile card (`contact-profile-card.tsx:109-118`) both `removeEmailsFromContact` then re-insert from client state, where `is_primary` is only ever set for index 0 at creation time (`is_primary: emails.length === 0`). Delete the primary row and every remaining row goes back as `is_primary: false`.
3. **"Preferred" does not mean primary.** The checkbox writes `contacts.preferred_contact_method` / `preferred_contact_value`. Nothing reads those two columns anywhere except the modal's own rehydration (`contact-edit-modal.tsx:175-181`) — verified by grep across `src/`. Checking Preferred on a second email changes nothing about where mail goes.

## Fourth defect, found while investigating — fixed in the same pass

`addEmailToContact` (`lib/data/contacts.ts:951`) inserts only `contact_id, email, is_primary`. `source` defaults to `'manual'` and `bounced_at` to `NULL`. Both delete-all/re-add loops run every *other* address back through it, so:

- **every contact save relabels `scraped` / `pattern_guessed` / `verified` addresses as `manual`**, and
- **every contact save clears `bounced_at` on all of them**, resurrecting addresses the daily bounce detector already retired. The docs page promises a permanent failure "refuses it everywhere after that" (`public/docs/index.html:732`); editing the contact undoes that.

Fix: `replaceContactEmails` **diffs** instead of nuking, so untouched rows keep their identity, provenance and bounce state.

## Decisions

| Question | Decision |
| --- | --- |
| Enforcement layer | **Database + data layer.** Partial unique index, demote/promote triggers, backfill. Six call sites write `contact_emails` directly; app-only enforcement is one new writer away from being wrong again. |
| Old address on extension re-add | **Bounced → hard delete. Live → keep, demote to secondary.** (Dawson.) Keeping a live one preserves address-keyed threading: `email_message_contacts`, `backfillEmailsForContact`, and reply attribution all match by address (CAR-227). |
| Survivor ranking when a primary disappears | non-bounced first, then source rank (`manual`/`verified` > `scraped` > `pattern_guessed`), then most recently added. Mirrors `EMAIL_SOURCE_RANK` in `lib/scrape-merge.ts:322`. |
| `contacts.preferred_contact_value` | Kept, and **derived** rather than independent: when the primary email changes and `preferred_contact_method = 'email'`, the value follows. Two sources of truth that can disagree is what made defect 3 invisible. |
| Preferred on a *phone* | Emails keep their own primary, untouched. `is_primary` is a property of the email set; "preferred method" is a property of the contact. |
| Re-adding an address that previously bounced | Its `bounced_at` is **cleared** when a human types it into the extension. Otherwise the promotion is a lie: the send path refuses an all-bounced contact, so the contact would show a primary nobody can send to. |

**One flag, then I build it as decided:** hard-deleting a bounced row deletes the app's only memory that the address is dead. Apify enrichment or a later scrape can re-add the same address as a fresh `scraped` row with `bounced_at = NULL`. It comes back as *secondary* (a live primary exists), so it is not a send target until the good address also dies — bounded damage, and the alternative is a tombstone table or a soft-delete column that every one of ~20 reads would have to filter. Noted, not re-litigated.

## Work

### 1. Migration — `supabase/migrations/<ts>_car279_one_primary_email.sql`

1. **Diagnostic + backfill.** For contacts with >1 primary, demote all but the best-ranked. For contacts with rows and 0 primaries, promote the best-ranked. Ranking as in Decisions.
2. `CREATE UNIQUE INDEX contact_emails_one_primary_idx ON contact_emails (contact_id) WHERE is_primary;` — makes "two primaries" unrepresentable.
3. `contact_emails_demote_other_primaries` — **BEFORE** INSERT OR UPDATE OF `is_primary`, `WHEN (NEW.is_primary)`: demote every other primary on that contact. Must be BEFORE, not AFTER: the index is immediate and non-deferrable (a partial unique index cannot be a deferrable constraint), so the demotion has to happen before the index is checked. No recursion — the nested `UPDATE ... SET is_primary = false` fails the `WHEN` clause.
4. `contact_emails_ensure_primary` — **AFTER** DELETE OR UPDATE OF `is_primary`: if the contact still has rows but no primary, promote the best-ranked. Terminates in one hop (the promoting update re-fires it, finds a primary, no-ops). AFTER ROW triggers fire at end of statement, so a delete-all sees the final empty state and promotes nothing.
5. Same function keeps `contacts.preferred_contact_value` aligned when `preferred_contact_method = 'email'`. Invoker rights, no `SECURITY DEFINER` — same argument as `reset_contact_email_sync_state` (`supabase/migrations/20260724000000_car172_...sql:25`): anyone who may write the email row may update its contact.

**Checked against every existing writer before writing the index:** `bulk-import.ts:690` and `bundle-fast-apply.ts:374` bulk-insert one email row per *newly created* contact (`mapped.email` is singular, `createdPending` only), so no statement carries two primaries for one contact. `updateExistingPerson` (`bulk-import.ts:1087-1095`) and `attachEmailToContact` both demote before inserting. `gmail.ts:1687` inserts discovered reply addresses as non-primary. Nothing FKs `contact_emails.id` (asserted in the CAR-153 migration, re-verified).

Validation per rule 32: run the migration against production inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` before pushing. Apply before merge (rule 42) — the route code below reads and writes columns the triggers govern.

### 2. Data layer — `careervine/src/lib/data/contacts.ts`

The invariant lives in the DB; these express *intent* and keep the mocked unit tests honest.

- `setPrimaryEmail(contactId, target)` — promote by row id or address.
- `deleteContactEmail(contactId, emailId)` — delete, then promote the survivor by the same ranking.
- `replaceContactEmails(contactId, entries)` — **diffing** replacement for the three delete-all/re-add loops: keep rows whose address is unchanged (preserving `source` / `bounced_at` / id), insert new ones, delete removed ones, land exactly one primary. If the caller marks none, keep the incumbent; if the incumbent is gone, rank.
- `attachEmailToContact` (`:983`) already holds the invariant — unchanged, and becomes the model the rest match.
- Retire `addEmailToContact` from the UI paths; keep it only where a contact was just created with no rows.

### 3. Extension re-add — `app/api/contacts/import/route.ts` (`updateExistingContact`, :260-286)

With a valid `contactInfo.email`, normalized to `lower(trim())` to match the DB trigger:

- matches an existing row → promote it, clear its `bounced_at`;
- new → insert as primary (triggers demote the rest);
- then hard-delete every *other* row with `bounced_at IS NOT NULL`.

Stays best-effort (`console.warn`, never fails the import), matching the current posture.

### 4. UI

- **`contact-edit-modal.tsx`** — "Preferred" on an email row now sets that row's `is_primary` and clears the others. Deleting a row that was primary promotes the top remaining row in client state (same rule as the trigger, so the optimistic UI matches what the DB does). The primary row carries a small `Primary` tag so the state is legible when the preferred method is a phone. Save through `replaceContactEmails`.
- **`app/contacts/page.tsx`** (add-contact form, :505-512) — same checkbox semantics, so "create with two emails, prefer the second" does the obvious thing.
- **`contact-profile-card.tsx`** (`saveEmail`, :106-124) — inline edit becomes `replaceContactEmails`, ending the provenance/bounce wipe.

No new controls, no second concept: one checkbox, and it now means what it says.

### 5. Tests

- **Integration** (`src/__integration__/one-primary-email.itest.ts`, real Postgres + PostgREST + RLS): deleting the primary promotes a survivor; two primaries are rejected; a bulk multi-contact insert of primaries passes; `preferred_contact_value` follows; the backfill fixes both a 0-primary and a 2-primary contact.
- **Unit**: import-route re-add (promote / bounced-delete / live-demote), the three data-layer functions, edit-modal Preferred→primary and delete→promote, profile-card provenance preservation (the regression test defect 4 never had).
- Falsify each new test by breaking the code it covers before keeping it (rule 52 — print the diff, confirm the probe hit the right function).
- Full `npm run test`, `npm run test:integration`, `npm run check:conventions`.

### 6. Copy

`public/docs/index.html` bounce section (:732-733) states a flagged address is refused everywhere afterward. Add that re-saving the person from the extension with a working address promotes it and clears out an address that had already bounced. No privacy-policy change: this stores nothing new and deletes more.

## Out of scope

New MCP tools for `set_primary` / `delete_email` (a live Cowork agent's tool list is fixed at connect; `add_contact_email` already holds the invariant), and the `preferred_contact_method` columns' broader future — they stay, now derived.
