# CAR-243 — Replies never move a company to Active outreach

## The ask

Every company where Dawson reached out to someone and they replied should show that
outreach under **Active outreach**, on the company where that contact **currently**
works. Backfill everywhere it should be backfilled.

## What is actually broken

CAR-239 shipped the automation for this. Measured against production 2026-08-06:
**12 contacts have a real email reply, and exactly one of their current employers
(Brevium) is at Active outreach.** Eleven targeted companies are still on Researching.

Three separate defects produce that, and fixing only the third means it re-accumulates.

### 1. The advance is wired to the sync path that never sees the reply

`/api/gmail/sync` runs `syncAllContactEmails` first ([route.ts:26](careervine/src/app/api/gmail/sync/route.ts:26)),
then `syncThreadReplies` ([route.ts:38](careervine/src/app/api/gmail/sync/route.ts:38)).

The per-contact sync builds its Gmail query from the contact's own addresses, so it is
the path that ingests essentially every reply, and it **inserts first**. The thread
sweep populates `repliedThreadIds` only from rows *it* newly inserted
([gmail.ts:1584-1601](careervine/src/lib/gmail.ts:1584)) — by then the reply is a
duplicate, so the set is empty. `advanceCompaniesForRepliedThreads` has exactly one
caller, [gmail.ts:1679](careervine/src/lib/gmail.ts:1679), inside that sweep.

Meanwhile the per-contact path *does* detect the reply and acts on it — activates the
contact, cancels follow-ups, emits `reply_received`
([gmail.ts:389-453](careervine/src/lib/gmail.ts:389)) — but never advances the company.

So the advance fires only when a reply arrives from an address we do not have on the
contact (the CAR-227 case). That is the rare path, which is exactly why one company
out of twelve moved.

### 2. It advances former employers

`advanceCompaniesForContacts` reads `contact_companies` with no `is_current` filter
([company-stage-advance.ts:56-65](careervine/src/lib/company-stage-advance.ts:56)), so a
reply advances every company the contact ever worked at. Kyle Evans replying would move
Walmart (left 2024), Goldman Sachs, Clearlink, HealthEquity, OpenSpace and Teem to
"Active outreach". Outreach is not active at a company someone left six years ago.

### 3. Nothing backfilled the replies that predate CAR-239

Forward-only by construction.

## Plan

**A. Scope the advance to current employment** — add `.eq("is_current", true)` to the
`contact_companies` read, and say in the header why (a reply is evidence about where the
person works *now*). A contact with no current employment row advances nothing, which is
the correct answer rather than a reason to fall back to all employers.

**B. Advance from the per-contact sync path** — inside the existing
`if (replies.length > 0)` block in `syncEmailsForContact`, call
`advanceCompaniesForContacts(supabase, userId, [contactId])`. The contact is already in
hand so no thread resolution is needed, and it only runs on a sync that actually ingested
a reply. Error-tolerated like the `cancelFollowUpsForRepliedThreads` call beside it: a
stale stage must never fail a mailbox sync. Keep the thread-sweep call for the
unknown-address case.

**C. Data migration** backfilling the existing gap. Set-based and derived from the data
at apply time rather than hardcoded target ids, so it is correct for every user and
idempotent. Replicates the TS reply rule exactly
([company-queries.ts:315-367](careervine/src/lib/company-queries.ts:315)): a non-simulated
inbound message whose `from_address` is one of the contact's own `contact_emails`, dated
on or after our earliest outbound to them. Then `is_current` employment -> that user's
`target_companies` rows still on `researching`. Mirrors onto `pipeline_cycles` where a
row exists.

Rule 32: validate by executing it against production inside
`BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` before applying for real.

**D. Tests** — extend `company-stage-advance.test.ts` for the `is_current` filter, and
cover the new per-contact call site.

## Expected result

target_companies **23, 68, 70, 73, 81, 93, 193, 203, 207, 213, 214** move to
`outreach_active`: Adobe, Podium, Entrata, Western Governors University, ZAGG,
CapitalROCK, R1 RCM, Quilt Software, Doxy.me, Helpside, Hona.

All eleven are `location_id = null` (company-wide scope) with **zero** `pipeline_cycles`
rows, so the company page seeds its stage straight off `target_companies.status` via
`cycleHintsFromTarget` ([use-pipeline-autosave.ts:124](careervine/src/hooks/use-pipeline-autosave.ts:124))
— writing the target row alone is enough for the page to render it.

## Deliberately out of scope

Two current employers have **no target row at all** and are left alone: Century 21 Everest
Realty (Samuel Faber's realtor side role) and Prodity (Kyle Evans' own consultancy).
Creating a target row is a targeting decision, not a stage backfill, and neither is a
company Dawson is pursuing. Flagged to him rather than silently skipped.
