# CAR-191 — Expand the E2E tier to the remaining six product flows

Wave 3 of CAR-182. All three blockers (CAR-188, CAR-189, CAR-196) are **Done** and
present on this branch (`dawson/car-191-c2f3a2` is exactly at `origin/main`).

Baseline measured before authoring anything: **6 passed in 33.6s**. The runtime
budget in the ticket (nine flows under ~4 minutes) is not close to binding — the
fixed `next build` dominates.

## What the audit comment changed

The ticket carries an `audit-corrections` comment that says "do not start yet" and
disputes four premises. Three of the four are now resolved by CAR-196 landing, and
the two that were factually wrong about the *product* are corrected here rather
than implemented as written.

| Ticket claim | Status | What this plan does |
| --- | --- | --- |
| Blocked on stub handlers for OpenAI / Apify / Resend / Gmail modify / trash / untrash / Serper | **Resolved.** CAR-196 added every one | Use them |
| Flow 7 unrunnable: fail-closed rate-limit buckets 429 in both envs | **Resolved.** The `.invalid` Upstash stub always allows and never counts | Use it |
| Flows assert on `window.confirm`, which auto-dismisses and passes for the wrong reason | **Resolved.** CAR-188 replaced all 12 with `ConfirmDialog` (`role="alertdialog"`, `data-testid="confirm-dialog"`) | Assert on the real dialog |
| "Each flow seeds its own tenant and tears it down" is the existing convention | **False.** The harness runs one shared tenant, `fullyParallel: false`, `workers: 1` | Keep the shared tenant as the default; flows 8 and 9 mint their own, in-test, and say why |
| Flow 8 is "the first automated check that the gate holds" | **False.** `api-handler-capability.test.ts` and `use-capabilities.test.tsx` already pin both primitives | Re-aim at what is genuinely uncovered: that a *specific real route* carries the right capability key |
| Teardown project missing; 21 orphaned tenants | **Resolved.** CAR-196 declared the `cleanup` project | Reuse it; extra tenants use the swept `itest-e2e-*` address space |

One further correction found while scoping, not in the audit: **`<Capable>` has zero
production call sites** (only its own doc comment and a unit test). The real client
capability branch in production is `useCapabilities` driving
`email-experience.tsx:39` — Outreach for free, Inbox for premium. Flow 8 tests that,
and its header says so plainly instead of claiming to cover a component nothing
renders.

## Per-flow design

### Flow 4 — `contact-add-enrich.spec.ts`

Manual add through the contacts form with a deliberately messy LinkedIn URL
(`HTTP://WWW.LinkedIn.com/in/Ada-Lovelace/?trk=x`), then assert Postgres holds the
canonical `https://www.linkedin.com/in/ada-lovelace`. That is the
`createContact` chokepoint in `src/lib/data/contacts.ts:252` proven end to end
through the UI for the first time.

Import path: `/contacts/preview#data=<encodeProfileData(...)>` — the real extension
hand-off surface — then Save, which posts `/api/contacts/import`. Importing a second
variant of the *same* profile URL must land on the **same contact row**, not a
duplicate. That is the canonicalization invariant the dedupe depends on, and it is
the assertion no mocked tier can make.

### Flow 5 — `inbox-triage.spec.ts`

Seed `email_messages` rows directly (the inbox reads `/api/gmail/inbox`, which reads
the table). Expand a thread, mark read, trash, and assert the change **survives a
reload** — server truth, not the optimistic update.

The race: `page.route()` with a deliberate delay on message A's
`GET /api/gmail/emails/{id}`, click A then B, and assert **B's** body renders. This
is a regression test for the `expandReq` token guard in `inbox-shell.tsx:163`
(CAR-145/F19), and the ticket is right that the mocked tier cannot express it.

Needs `data-testid` on the thread row, the message row, and the expanded body — the
inbox has none today.

### Flow 6 — `calendar-sync.spec.ts`

The CAR-175 regression. Seed a `calendar_events` row whose `google_event_id` matches
the stub, with all four application-owned columns populated
(`source_gmail_thread_id`, `source_gmail_message_id`, `meeting_id`, `zoom_link` —
two of which have no writer in the app at all, so the service client seeds them, as
the audit noted). Sync from the calendar page, then assert all four survived while
the Google-owned fields were refreshed.

Requires one harness edit: `calendarEventsResponse()` currently defaults to
`items: []`, so a sync returns nothing. The `register.mjs` handler gets a fixed,
named event. Static, not varied — the worker has no channel into the server process,
and a *known* id is all this flow needs.

### Flow 7 — `settings-keys.spec.ts`

Add a Deepgram key (validated against the stubbed `GET /v1/projects`), add an OpenAI
key, then disconnect Gmail. The confirm assertions are the point: the
`role="alertdialog"` appears, **Cancel leaves the connection intact** (checked in
Postgres, not just on screen), and only Confirm actually disconnects.

### Flow 8 — `capability-gating.spec.ts`

Own tenant, seeded free: `modify_scope_granted: false`, `premium_enabled: false` →
`capabilitiesFor` yields `{outreach:portal}` alone. Session minted in-test by
navigating `/auth/confirm` (same mechanism as `auth.setup.ts`), so the file needs no
storageState juggling.

- Client: `/email` renders Outreach, never the Inbox shell.
- Server: `GET /api/gmail/labels` (`mailbox:read`) and the mailbox-modify routes
  return **403**, reached by direct URL rather than through a button.

### Flow 9 — `admin-surface.spec.ts`

Non-admin (the shared tenant) is redirected off `/admin` by the layout gate. A second
tenant promoted with `app_metadata.role = "admin"` via the service client reaches
`/admin/users`. The "for ALL accounts" bulk toggle shows its confirm, and **cancel
leaves every account's flag unchanged** — verified in Postgres.

## Rules held

- Web-first assertions only. No `waitForTimeout`, no sleep. `expect.poll` for
  anything outside the DOM.
- Every external origin stubbed; an unstubbed one fails the test on both halves.
- New `data-testid` only where role plus name is genuinely unreachable.

## Verify

`npx playwright test` against the local stack, **three consecutive green runs**
(the ticket's stated bar), runtime confirmed under budget, then CONVENTIONS.md
section i updated for anything that changed and the PR opened.
