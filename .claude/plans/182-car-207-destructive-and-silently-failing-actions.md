# CAR-207 — Destructive and silently-failing actions

Seven defects from the Wave 2 audit. All seven land in this branch; nothing is
filed forward (rule 49).

Research established three things the ticket got slightly wrong, each of which
changes the fix. They are called out inline below.

---

## 1. Attachment delete: no confirm, silent failure, partial-upload blindness

`careervine/src/components/contacts/contact-attachments-tab.tsx`

Confirmed: three bare `console.error`s (37, 55, 64), no `useConfirm`, no toast.
`handleUpload` refreshes only after the loop, so a throw on file 3 of 5 leaves
files 1–2 written and invisible.

**Fix**
- `useConfirm({ destructive: true })` on delete.
- `withToastOnError` on upload / download / delete.
- Upload's list refresh moves into a `finally` inside the action, so a partial
  batch still reflects what landed.
- Synchronous re-entry guards: a per-id `Set` ref for delete, a boolean ref for
  upload. Both drain their `DOUBLE_SUBMIT_BASELINE` entries.
- `handleDownload` gets a `// reentry-safe:` annotation: it becomes a "mutation
  handler" to the detector only because `withToastOnError` is on the
  ALWAYS_MUTATING list, and it writes nothing.

## 2. Subscribe races the UNIQUE constraint and reports failure on success

`careervine/src/components/settings/data-subscriptions-section.tsx` +
`careervine/src/app/api/bundles/subscribe/route.ts`

Confirmed on both halves. `UNIQUE (user_id, bundle_id)` exists
(`20260709000000_data_bundles.sql`); the route reads with `maybeSingle()` then
inserts, so two POSTs both see null and the loser raises 23505, which the
`if (error)` arm maps to a flat 500.

**Fix**
- Client: per-bundle `Set` ref claimed before the first await, released in
  `finally` (CAR-204 shape, which the guard recognises). `handleUnsubscribe`
  gets a boolean ref in the same pass; it POSTs a destructive contact-removal
  loop and is the other half of that file's baseline entry.
- Route: on `error.code === "23505"`, re-read the row the winner created and
  return it as success. The subscription genuinely exists and is syncing.

## 3. A delivered follow-up can be re-sent by one click

`careervine/src/app/api/cron/send-follow-ups/route.ts` **and**
`careervine/src/app/api/gmail/follow-ups/confirm/route.ts`

Two corrections to the ticket:

- The defect is in **two** send drivers, not one. Both mark-sent writes are
  unchecked (`route.ts:348`, `confirm/route.ts:163`), and both leave the row in
  `sending` on failure.
- "Copy that shape" cannot be done without a migration. The scheduled-email
  sweeper writes `ScheduledEmailStatus.Failed`; `email_follow_up_messages` has
  no `failed` in its CHECK
  (`pending|sending|sent|cancelled|awaiting_review|expired`, per
  `20260712065000_car105_followup_nudge_expiry_columns.sql`). Rule 40 says the
  CHECK is schema truth, so the value has to be added before anything writes it.

The re-send path: send succeeds → mark-sent write fails silently → row stays
`sending` → the stale-claim sweeper parks it `awaiting_review` with the full
CAR-105 stamp → portal renders "Send now" → the contact gets it twice.
CAR-139 deliberately avoided *auto*-retry but chose a state whose whole UI
affordance is a one-click manual retry, presented as "not sent yet".

**Fix**
- Migration adding `'failed'` to the CHECK, and `FollowUpMessageStatus.Failed`
  in constants. Deliberately absent from OPEN / UNRESOLVED / ACTIONABLE, so it
  is terminal, un-actionable, un-nudged, and does not hold the parent open.
- Sweeper: stale `sending` + **active** parent → `failed` (was
  `awaiting_review`). Dead parent → `cancelled`, unchanged.
- Both drivers: bind and check the mark-sent `error`. On failure log loudly and
  leave the claim for the sweeper, matching `gmail.ts`'s scheduled-email
  comment verbatim in intent.
- Sweeper also runs the parent-completion check for swept sequences, or a
  sequence whose only open step just went terminal stays `active` forever with
  nothing to do.
- UI: the three surfaces that enumerate message statuses
  (`contact-emails-tab`, `followups-tab`, `outreach-shell`) render `failed`
  honestly ("may already have been sent"), with no send affordance. All three
  already have this exact treatment for scheduled emails.

Rule 42: the migration is applied **before** merge. Code that writes `failed`
against the old CHECK gets 23514.

## 4. Retention DELETE runs against a truncated read

`careervine/src/lib/data-retention.ts`

Ticket cites line 106. Line 101 is truncated too, and the severity is inverted
from what the ticket describes:

- `data_bundles.select("id")` (101) truncating means bundles past the first
  1000 are never purged — under-deletion, which is what the ticket describes.
- `bundle_subscriptions` (106) truncating is **over**-deletion, and that is data
  loss: `minSynced` is the floor across active subscriptions, so a truncated-away
  subscriber raises the threshold, and `lte(removed_in_version, threshold)` then
  hard-deletes soft-removed prospects that subscriber still needs for its removal
  delta. If every subscription for a bundle falls outside the window,
  `minSynced.has()` is false, threshold becomes `MAX_SAFE_INTEGER`, and *all* its
  soft-removed rows go.

**Fix**: both reads paginate through `paginateAll` with a deterministic
`.order("id")`, per CONVENTIONS §d.

## 5. A large company's people list is short and unstable

`careervine/src/lib/company-queries.ts` — `getCompanyDetail`'s
`contact_companies` read asks for `.limit(2000)` against the 1000-row ceiling
with no `.order()`.

**Fix**: `paginateAll` + `.order("id", { ascending: true })`.

## 6. `/interactions` spins forever

`careervine/src/app/interactions/page.tsx` is a live authenticated route whose
component requires `contactId`, which Next never passes. `loading` starts `true`,
`loadInteractions` early-returns, the effect is gated on the same absent id, so
the spinner never resolves.

The component has **zero importers** — its own header says it is meant to be
embedded and that standalone interaction management belongs to the Activity page
(`/meetings`), and `/meetings` does in fact own the unified meetings +
interactions timeline with full create/edit/delete. The embedded case is served
by `contact-timeline-tab.tsx`.

**Fix**: replace the route with a redirect to `/meetings`. Rendering "all
interactions" instead would build a second surface duplicating the Activity page
(rule 5). This drains that path's two `DOUBLE_SUBMIT_BASELINE` entries and its
`LATEST_REQUEST_BASELINE` entry, which the ratchet's dead-path check requires.

## 7. One raw fetch survives outside the guard's reach

`careervine/src/lib/bundle-apply-client.ts:50`

Correction to the ticket's diagnosis: the guard's directory scope **already**
covers `src/lib` — CAR-190 added a second scope for exactly that. What hides
this call is its **variable URL**: outside the client tree the guard only fires
on a URL literal starting with `/api/`, and `fetchStepWithRetry(url, …)` takes
the path as a parameter. Widening the directory scope would fix nothing.

**Fix**
- Route the call through `apiFetch`. It needs status-aware control flow (retry
  5xx, branch on 409, read the error body), and `ApiRequestError` carries
  `status`/`code`/`body`, so the retry loop returns a discriminated
  `{ ok: true, step } | { ok: false, status, error }` instead of a raw
  `Response`. Both callers (`runBundleApplyLoop`, `handleUnsubscribe`) move onto it.
- Close the real hole: the guard computes **browser reachability** by import
  graph from the client files, and applies the full no-raw-fetch ban to every
  reachable module, whatever its URL shape.

  Measured before choosing this: 68 modules outside the client tree are
  client-reachable, and exactly two of them contain a raw `fetch` —
  `api-client.ts` (the sanctioned wrapper, already exempt by name) and this
  defect. All six server-side third-party fetchers (`serper`, `apify/client`,
  `notify/email`, `admin-actions`, `admin-notify`, `import-db-helpers`) are
  unreachable from the client, so the rule lands at zero with no false
  positives and no new baseline.

---

## Tests

Per the ticket, plus what the corrections above add:

- attachments: delete requires a confirm; a refused delete leaves the row and
  toasts; a partial upload batch still refreshes; double-click writes once.
- subscribe: double-click POSTs once; a 23505 insert answers success, not 500.
- follow-ups: a mark-sent failure leaves a row that is **not** re-sendable, in
  both drivers; the sweeper writes `failed`, not `awaiting_review`; `failed` is
  absent from OPEN/UNRESOLVED/ACTIONABLE; a swept sequence completes.
- retention + company detail: seeded past 1000 rows in the **integration** tier
  (a mock cannot express a PostgREST ceiling), asserting full coverage and a
  stable first page across two loads.
- `/interactions` redirects.
- conventions guard: a fixture proves the reachability rule trips on a
  variable-URL fetch in a client-reachable `src/lib` module.

## Verify

`npm run test`, `npm run check:conventions`, `npm run lint`, `tsc --noEmit`,
`npm run build` — all from `careervine/`, and `.next` moved aside first for the
cold lint/typecheck (rule 48).
