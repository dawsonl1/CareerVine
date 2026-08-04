# CAR-109 — Contact profile: fetch prior email history (paid tier) + clickable company

Fixes the two remaining observations on CAR-109 (calendar surfacing is split to CAR-110).
Both are code-only, no schema.

## 1. Company on the profile isn't clickable

**Root cause:** the profile already has `companies.id` (from `getContactById`'s
`contact_companies(*, companies(*))` join) but renders the company as plain text.
The contacts *list* page links the identical data (`contacts/page.tsx:597-607`).

**Change (front-end only, mirror the list page):**
- `careervine/src/components/contacts/contact-profile-card.tsx` — wrap the
  current-company name (subtitle line ~280-286) in `<Link href={/companies/${id}}>`.
- `careervine/src/components/contacts/contact-experience-card.tsx` — wrap each
  `cc.companies.name` (primary line when no title, and the subtitle when titled)
  in a link to `/companies/${cc.companies.id}`.
- Use `next/link` with `hover:text-primary hover:underline`. No DB/query change.

## 2. Prior email history never appears on a newly added contact

**Root cause:** real Gmail history is only ever fetched *per existing contact*
(`syncEmailsForContact`), and the on-add `backfillEmailsForContact` only re-links
already-cached orphan rows — a no-op for a person who was never a contact when you
emailed them. So nothing is ever fetched for them.

**Change:** on contact create/update with an email, fetch that person's Gmail
history so pre-existing correspondence appears on their profile.

- New module `careervine/src/lib/contact-email-history.ts` exporting
  `syncContactEmailHistoryIfPaid(userId, contactId, emails)`:
  1. no emails → return 0
  2. `resolveCapabilities(userId)`; **skip unless `caps.has("mailbox:read")`** —
     this is the **paid-tier gate**. Free-tier connections hold only `gmail.send`
     (no inbox read scope, CAR-102), so there is nothing to fetch. Per Dawson's
     requirement, only paid accounts fetch.
  3. `getConnection(userId)`; if not connected → return 0
  4. `syncEmailsForContact(userId, contactId, emails, conn.gmail_address, 90)`
- Wire into `careervine/src/app/api/contacts/import/route.ts` (the shared
  post-create/update block at ~104-108, alongside the existing backfill).
  **Awaited** inside try/catch so it's reliable on Vercel (no fire-and-forget that
  the platform may freeze) yet can never fail the import. Runs for both the new
  and updated contact paths.

**Why a separate module:** keeps the tier-gating logic unit-testable by mocking
`@/lib/gmail` + `@/lib/capabilities/resolve` (route-level POST testing is heavy
due to extension auth).

## Tests

- `careervine/src/__tests__/contact-email-history-tier.test.ts` (new), mirroring
  `gmail-emails-route-tier.test.ts`:
  - paid (`mailbox:read`) + connected → `syncEmailsForContact` called with the
    contact's emails + `gmail_address` + 90; returns synced count.
  - free (no `mailbox:read`) → Gmail never touched, returns 0. **(the core requirement)**
  - paid but not connected → no fetch.
  - empty emails → no fetch.
- Full `npm run test` + `npm run build` from `careervine/`.

## Out of scope / notes

- Calendar-on-profile → CAR-110.
- Free-tier email history stays a product decision (needs `mailbox:read` scope) —
  not changed here.
- Docs (rule 34): checked `careervine/public/docs/index.html` — no copy describes
  contact-profile email history or company links, so no docs change.

## Sequence

1. Branch synced from `main` before PR.
2. Implement module + route wiring + two components.
3. Add test; `npm run test` + `npm run build` green.
4. Open PR titled with `(CAR-109)`; stop for merge go-ahead.
