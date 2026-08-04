# CAR-133 — Fix cross-tenant contact leak in calendar sync + IDOR in gmail/emails

Two security bugs from the 2026-07-16 re-audit (F10 root cause: cross-tenant
safety resting on hand-written `user_id` filters against RLS-bypassing
service-role clients). Both fixes touch the sync files, so one worktree.

## Bug 1 — R2.1 (CRITICAL, cross-tenant contact leak)

`src/app/api/calendar/sync/route.ts:133-137` matches attendee emails to
`contact_emails` with the service client and **no user scoping**. Because
`contact_emails` has no `user_id` column, the match is global across all
tenants. A foreign `contact_id` then lands on the user's `calendar_events`
and `calendar_event_contacts`, and the MCP read path returns the foreign
contact's name to the wrong user.

**Fix:** scope the match through the `contacts!inner(user_id)` join, mirroring
the correct sibling `src/lib/gmail.ts:764-770`:
```ts
.select("contact_id, contacts!inner(user_id)")
.in("email", attendeeEmails)
.eq("contacts.user_id", user.id)
```

## Bug 2 — R2.6 (IDOR)

`src/app/api/gmail/emails/route.ts:30-33` reads `contact_emails` by raw
`contactId` with the service client, never checking the contact belongs to
`user.id`, then fire-and-forgets `backfillEmailsForContact` /
`syncEmailsForContact` with the (possibly foreign) addresses.

**Fix:** verify the contact is owned by the authenticated user up front
(`contacts` ownership query scoped to `user.id`); return 404 otherwise, before
any read or background job runs.

## While-here audit

- `src/mcp/lib/db.ts:1216-1218` — the `calendar_event_contacts` embed selects
  `contacts(id, name)` with no user filter. The parent `eventIds` come from the
  user's own scoped `calendar_events` (db.ts:1191-1199), so once Bug 1 stops
  writing foreign links this is not exploitable, but add `contacts!inner(user_id)`
  + `.eq("contacts.user_id", uid())` on the link query as defense-in-depth.
- Grep both routes for other unscoped service-client `contact_emails`/`contacts`
  reads.

## Tests

- `calendar-sync-route.test.ts`: current mock returns `[]` for `contact_emails`
  so the match path has zero coverage. Add a test proving a foreign-tenant
  `contact_email` is NOT matched (assert the `.eq("contacts.user_id", …)` filter
  is applied and no foreign `contact_id` reaches the upsert).
- `gmail-emails-route-tier.test.ts` (or a sibling): add an ownership-mismatch
  test asserting a foreign `contactId` returns 404 and triggers no background
  sync/backfill.

## Verification

`npm run test` and `npm run build` from `careervine/`.
