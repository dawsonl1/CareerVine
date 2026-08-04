# CAR-217 — Handle bounced emails properly

When an outbound email bounces, CareerVine should stop everything still queued to
that address and tell the user. Today it does neither reliably.

## What already exists

Bounce handling is half-built, which is why the gaps are easy to miss:

- `detectBounces` (`careervine/src/lib/gmail.ts`) queries Gmail for NDRs, sets
  `contact_emails.bounced_at`, and cancels `email_follow_ups` sequences with
  `cancelled_bounce`.
- `sendTrackedEmail` (`careervine/src/lib/email-send.ts`) refuses a known-bounced
  recipient with a 422, for every user and every surface including the crons.
- `compose-email-modal.tsx` and `companies/person-modal.tsx` both already show a
  bounced address to the user.

So the address-level plumbing is there. What is missing is everything that makes it
act on its own and tell anyone about it.

## Gaps this ticket closes

1. **Delay warnings are not distinguished from permanent failures.** `detectBounces`
   treats the presence of `X-Failed-Recipients` as proof of a bounce. It requests
   `Subject` in `metadataHeaders` and then never reads it, which is a strong hint
   that this discrimination was intended and never written. The authoritative
   signal is the DSN's `Action` / `Status`, not the header's presence.
2. **Non-Gmail NDRs are missed.** When the recipient's own MTA generates the
   rejection (Microsoft 365 and friends), the NDR carries an RFC 3464
   `message/delivery-status` part and no `X-Failed-Recipients`. It matches the
   search query, then yields no address, so nothing happens.
3. **`scheduled_emails` are never cancelled.** `detectBounces` touches follow-ups
   only. A pending scheduled email to a dead address 422s on every hourly tick and
   retries indefinitely. `email-send.ts`'s header asserts the bounce path resolves
   it; that claim is simply false today.
4. **Nothing notifies the user.** No `sendAppEmail` call exists on any bounce path.
5. **Detection never runs unattended.** The only caller is `POST /api/gmail/sync`,
   reached from the Inbox page and the settings "Sync now" button. A bounce
   notification that can only be generated while the user is already looking at the
   app is close to useless.
6. **The contact page is silent.** `contact-profile-card.tsx` renders the email with
   no indicator, disagreeing with the two surfaces that do show one.

## Tier decision

Dawson asked whether this should be premium-only. The two halves answer differently.

**Detection is premium-only, and that is a token fact rather than a product choice.**
The free consent is sign-in + `gmail.send` (`FREE_GMAIL_SCOPES`); `gmail.modify` is
appended only for a premium connect (`shouldRequestGmailModifyScope`). Listing
messages requires a read scope, so `gmail.users.messages.list` — the first call
`detectBounces` makes — cannot succeed on a free token at all. Making detection free
would mean adding a read scope to the default consent, which is exactly what CAR-102
removed to keep verification CASA-free and lift the 100-user cap. Not worth
reopening for this.

**Everything downstream stays ungated for every user**: the warning icon, the send
refusal, the cancellation, the notification. Three reasons:

- `sendTrackedEmail` already refuses bounced addresses with no capability check, so
  a free user can hit that 422. The icon is what explains it; gating the icon leaves
  the refusal inexplicable.
- `premium_enabled` is an admin switch that can move a user to free *after* their
  bounce data exists. That data still governs their sends, so hiding it would be
  hiding the cause of a refusal they are still subject to.
- For a never-premium user the column is always null, so the icon never renders
  anyway. A gate would be dead code that can only ever produce disagreement between
  the contact page and the two surfaces that are already ungated.

Existing capability vocabulary needs one correction: `followups:auto` is documented
as "cron auto reply-detection + bounce-cancel", but no cron has ever done
bounce-cancel. The shipped gate on bounce work is `mailbox:read` (via the sync
route), and the new cron will match that rather than invent a second answer.

## Implementation

### 1. Detection correctness (`careervine/src/lib/gmail.ts`)

Extract the NDR parse into a testable pure function, likely
`careervine/src/lib/bounce-parse.ts`, so the address extraction can be unit-tested
without a Gmail double.

- Require **permanent-failure evidence** before marking an address. Accept
  `Action: failed` with `Status: 5.x.x` from the delivery-status part; treat
  `4.x.x` / `Action: delayed` as a retryable delay and ignore it. Where only the
  legacy header is available, use the subject to separate Failure from Delay.
- Add the **RFC 3464 fallback**: when `X-Failed-Recipients` is absent, fetch the
  message `full` and walk parts for `message/delivery-status`, reading
  `Final-Recipient` / `Original-Recipient` (`rfc822;` prefix stripped).
- Keep the metadata-first path so the common Gmail case stays cheap; only messages
  lacking the header pay for a `full` fetch.

### 2. Cancel everything doomed (same function)

Alongside the existing follow-up cancellation, cancel `scheduled_emails` for the
user where `to_email` matches and `status = 'pending'`. Deliberately **not**
`'sending'` — that is a live claim held by a send driver mid-Gmail-round-trip, and
stealing it would race the sweeper. Correct `email-send.ts`'s header, which
currently documents behavior that does not exist.

### 3. Notify the user

- New `careervine/src/lib/notify/bounce-alert.ts` rendering the email (contact name,
  address, what was cancelled, a link to the contact).
- Fire only on the **null → bounced transition** (the existing `toMark` set), never
  on re-detection, or every sync would re-notify.
- Resolve the recipient with `service.auth.admin.getUserById`, as the nudge cron does.
- Resend `idempotencyKey` keyed on user + address + day so QStash's at-least-once
  retries dedupe.
- Preference: `users.bounce_alerts_enabled` (`NOT NULL DEFAULT true`), granted to
  `authenticated` for UPDATE like `followup_nudges_enabled`, toggled in
  `account-section.tsx`'s existing "Email notifications" block. Extend
  `NotificationPurpose` to a second slug so one-click unsubscribe works — note
  `verifyUnsubscribeToken` currently hardcodes the single purpose string and must
  become a set membership check.

### 4. Run it on a schedule

New `POST /api/cron/detect-bounces`, `withQStashVerification` outside `withCronGuard`
per §b. Selects `gmail_connections` rows resolving to `mailbox:read` via
`capabilitiesFor`, intersects with `filterActiveUserIds`, and runs `detectBounces`
per user with per-user error isolation. Registered in
`careervine/scripts/qstash-schedules.mjs` (daily; bounces are not minute-sensitive
and the Fluid budget is tight per CAR-106), then `node scripts/qstash-schedules.mjs sync`.

### 5. Contact page indicator

In `contact-profile-card.tsx`, resolve the **row** rather than just the address, so
the indicator matches the email actually rendered (`is_primary` first, else `[0]`).
Render `AlertTriangle` in `text-error` wrapped in the existing
`components/ui/tooltip.tsx`, label along the lines of "The last email to this address
bounced". Check the label against `Tooltip`'s `whitespace-nowrap` inside the narrow
profile card and relax it if it overflows.

### 6. Copy and docs

Per the Docs & copy drift section: docs page (bounce behavior is user-visible), the
privacy policy (a new stored preference column and a new category of outbound email
to the user), README if the product story changes, and `CONVENTIONS.md` §e if the
`email-send.ts` pointer text moves.

### 7. MCP agent safety (added mid-build)

Dawson's Cowork agent reported seven sends as landed when three had bounced, and
discovered it only by inventing a `from:mailer-daemon` search. Three defects on
that surface, folded into this ticket at his direction:

- `resolveRecipient` WARNED on an address the contact does not have and proceeded.
  All three bounces were guesses. Now throws `UnverifiedAddressError`, past only
  with `allow_unverified_address: true`.
- `send_email` returned `Sent to <name>`, a delivery claim the app cannot make.
  Now `Handed to Gmail` plus `delivery: "unconfirmed"`, in the summary itself.
- No verification path existed. New `check_delivery` tool, plus a bounce
  annotation on `search_email_history` results.

The design rule this establishes, recorded in the `tools/email.ts` header: when
the caller is a model, a guardrail must be a **thrown error or a required
parameter**, and anything that must not be misreported belongs in the **summary
sentence**, not a sibling field. Advisory warnings and skill-file rules do not
hold. The agent's own report demonstrated the latter: step 8 of that file still
contradicted a rule set the day before.

## Verification

- Unit: delay-vs-failure discrimination, RFC 3464 extraction, scheduled-email
  cancellation, notify-once-per-transition, unsubscribe token round-trip for both
  purposes.
- `cron-schedules-registry.test.ts` will fail until the new route is registered in
  both directions — that is the intended tripwire.
- `npm run test`, `npm run check:conventions`, `npm run build` from `careervine/`.
- Migration applied against production before merge per rule 42: the new column is
  additive and nullable-with-default, so it is safe to apply early, and the code
  reads it.
