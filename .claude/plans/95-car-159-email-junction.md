# CAR-159 — Multi-contact email attribution: `email_message_contacts` junction

**Branch:** `dawson/CAR-159-email-junction` (worktree `car-154-implementation-9f8712`, renamed from its original slug so the Linear hooks bind).
**Blockers:** CAR-146 (data-layer split) and CAR-153 (normalized `contact_emails` + fake-gmail harness) — both Done.

## Problem

`email_messages.matched_contact_id` is single-valued, so a thread involving two tracked contacts (intro email: recruiter + hiring manager) is attributed only to whichever contact synced first (audit finding R2.7). Mirror the `calendar_event_contacts` junction model.

## 1. Migration — `supabase/migrations/20260719130000_car159_email_message_contacts.sql`

- `email_message_contacts (email_message_id INTEGER REFERENCES email_messages(id) ON DELETE CASCADE, contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE, PRIMARY KEY (email_message_id, contact_id))` — exact mirror of `calendar_event_contacts`.
- Index on `contact_id` (PK covers the message→contacts direction).
- RLS: user policy via `EXISTS (… email_messages em WHERE em.id = email_message_id AND em.user_id = auth.uid())` + explicit service-role policy (this table family's convention).
- **Backfill (set-based, in the migration):**
  1. `(id, matched_contact_id)` for every message with a match — preserves all current attribution.
  2. Address-based repair: join `email_messages` → same-user `contacts` → `contact_emails` on `lower(from_address) = ce.email OR EXISTS (unnest(to_addresses) t: lower(t) = ce.email)` — this is the actual R2.7 fix for historical data, reliable because CAR-153 normalized `contact_emails.email` to `lower(trim())` with a chokepoint trigger. `ON CONFLICT DO NOTHING`.
- `matched_contact_id` (and its index) stays as the denormalized primary during transition — display readers and reply-attribution keep using it.
- Rule 32 rehearsal (`BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` against production), then `supabase db push` **before merge** (rule 42: this PR's code reads the table it creates; a new table is additive-safe for deployed code).
- Regenerate `database.types.ts` via `npm run gen:types` (local migration chain; CI types-drift job enforces).

## 2. Writers — one junction link per matching contact

Every site that sets `matched_contact_id` also writes junction links; all junction writes are `upsert(…, { onConflict: "email_message_id,contact_id", ignoreDuplicates: true })` for concurrent-sync idempotency.

- **`gmail.ts` `syncEmailsForContact`**: the whole page is by construction about `contactId` (Gmail query is scoped to the contact's addresses), so link every row in the page — the existing-row lookup and the insert-upsert both gain `id` in their selects; one junction upsert per page covering inserted + existing rows. This is what fixes "second contact's sync sees the row already exists and only updates safe fields": it now also links.
- **`gmail.ts` `backfillEmailsForContact`**: keep the legacy orphan-claim updates (count-based, rule 17) untouched; add junction linking for **all** messages matching the contact's addresses (not just orphans), paginated selects of `id` (PostgREST 1000-row cap), chunked junction upserts.
- **`email-send.ts`**: the sent-message upsert gains `.select("id")`; link every contact whose `contact_emails` row matched `toAddr` (the provenance query already returns them all — today only row[0] is used). Extend the last-touch `interactions` insert to all matched contacts (an email to an address shared by two contacts touched both).
- **`follow-up-reply.ts`** (manual mark-replied): the outbound lookup gains the outbound row's junction links; the simulated inbound insert gains `.select("id")` and links the union of the outbound's linked contacts + its `matched_contact_id`.

## 3. Readers — per-contact reads go through the junction

Union semantics come free: migration backfill covers history, writers cover everything new, so junction-only reads are complete. Display-only uses of `matched_contact_id` (inbox grouping, drafts enrichment, follow-up-reply attribution, `gmail-helpers` thread contact) stay on the denormalized column.

| Reader | Change |
| --- | --- |
| `app/api/gmail/emails/route.ts` (contact timeline) | `.eq("matched_contact_id", id)` → `email_message_contacts!inner(contact_id)` embed filter |
| `company-queries.ts` stage signals (~:91) | query from the junction side: `email_message_contacts.select("contact_id, email_messages!inner(direction, date)")`, chunked `.in("contact_id")`, mapped to the existing aggregation shape |
| `mcp/lib/db.ts` `searchEmailHistory` (:654) | conditional `!inner` embed when `contactId` provided |
| `mcp/lib/db.ts` dossier recent-emails + count (:870–:881) | embed filter; count from junction side; strip the embed key so the dossier payload stays byte-identical |
| `app/api/gmail/ai-followups/generate/route.ts` (:115) | embed filter |
| `lib/analytics/server.ts` `checkCompaniesEmailedMilestone` (:186) | junction-side read (more accurate multi-contact milestone) |

## 4. Tests (fake-gmail harness, CAR-153)

- Harness: `helpers/fake-gmail.ts` gains per-table auto-increment `id` assignment on insert/upsert (junction links need RETURNING ids).
- **Two-contact fixture (exit criterion)**: one thread To recruiter + hiring manager; sync contact A then contact B → one `email_messages` row, junction links for **both**; backfill path asserted the same way (message already claimed by A gets a link for B).
- **Concurrent idempotency**: overlapping syncs of the same contact → exactly one junction row (UNIQUE pair).
- **Backfill against seed data**: orphans claimed (legacy count preserved) + links written for already-claimed messages.
- Update existing suites touched by select-shape changes (`gmail-sync-contact`, `backfill-emails-cas`, `email-send`, `mark-replied-route`, `gmail-emails-route-tier`, MCP `db-scoping`/`dossier`).
- `npm run test` + `npm run build` green; MCP CAR-151 scoping test untouched-green.

## 5. Order of operations

1. Migration file + rule 32 rehearsal against production (BEGIN/ROLLBACK).
2. `supabase db push` (standing authority, rule 27; early-apply per rule 42) + `npm run gen:types`.
3. Writers → readers → tests.
4. Docs page check (rule 34): timelines now show shared threads on every involved contact — update copy if the page describes per-contact email history. Privacy policy (rule 46): no new data category (the junction re-expresses existing message↔contact attribution); no change expected, verify.
5. PR with `(CAR-159)` title; stop at PR per the worktree lifecycle.
