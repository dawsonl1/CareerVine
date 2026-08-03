# CAR-213 — University field at signup, and a school-aware experience

## Problem

CareerVine assumes every account holder is a BYU student or alum. There is nowhere
for a user to say otherwise, and the assumption is hardcoded across the bundle sync,
onboarding, company pages, the MCP dossier, the onboarding email templates, the docs
page, and the README.

The user-visible consequences for a non-BYU signup today: they are offered a database
described as "1,420 BYU alumni", their company list is ranked by BYU-alumni count,
their contacts carry BYU badges, their next-action lines read "Reach out to Sarah,
your BYU alum in product", and their first outreach email opens with **"I'm a student
at BYU"** — in *both* template variants, including the one that exists precisely to
avoid claiming a connection that isn't there.

## What "not relevant to a non-BYU user" actually means

Not *every* BYU alum. A BYU alum in a product role at a target company is a PM at a
target company — useful to anyone, regardless of where they went to school. What is
irrelevant to a non-BYU user is the alum who is in the bundle **only** because of the
alumni angle: no product role, not a recruiter.

**The exclusion rule:** a prospect is skipped for a non-affinity subscriber when they
are a BYU alum **and** hold neither a product-role persona (`alum_product`,
`product_leader`, `product_peer`) nor `recruiter`. Recruiters stay — a recruiter at a
target company hires regardless of your school.

Against the live bundle that predicate selects **exactly the `alum_other` population and
nothing else** (888 of 888, zero false positives, zero misses). The semantic predicate is
what ships, not `persona = 'alum_other'`: the equivalence is a property of today's data,
not a guarantee, and a future publish carrying a new or null persona must fail safe.

## Measured composition of the live bundle

Read-only query against published `apm-data-bundle` v4 on 2026-07-28, measured under the
rule above. These numbers drive most of the design decisions below, so they are recorded
here rather than left implicit.

| Metric | Value |
|---|---|
| Live prospects | 2,000 |
| **Dropped for a non-affinity user** | **888 (44%)** — all `alum_other` |
| **Kept** | **1,112 (56%)** |
| ↳ of which are still BYU alumni | **532** — kept as PMs and recruiters, never badged as alumni |
| Bench-tier prospects | 856, **all of them inside the drop set** |
| Bundle companies | 99 (89 hold at least one prospect) |
| Companies holding a kept prospect | **87** — 12 render empty for a non-BYU user |
| Kept per company | median 7, max 17 |

Kept persona split: 474 `alum_product`, 270 `product_leader`, 237 `product_peer`,
131 `recruiter`.

Two consequences that shape the plan:

- A non-BYU user's bundle is **56% the size** of a BYU user's and covers 87 of 99
  companies. Every count, stat, and piece of onboarding copy that quotes a number still
  has to become school-aware, or the product will lie to them.
- The **bench tier disappears entirely** for them, and that is fine rather than a loss:
  bench is a contained data-only tier, already collapsed on company pages and already
  excluded from outreach, suggestions, and network health. Nothing actionable is removed.
- The 532 alumni who remain are the crux of the highlighting half: they stay in the
  bundle, and they must **not** carry a BYU badge for a non-BYU user. They are PMs who
  happen to be BYU alumni, and for that user that fact is not a warm door.

## Decisions taken (Dawson, 2026-07-28)

1. **Bundle: filter at sync.** One bundle, one publish pipeline. Non-BYU subscribers
   skip alumni-only prospects at apply time and receive the other 1,112.
2. **Existing accounts: backfilled to BYU.** That is today's de-facto assumption, so no
   live account changes behaviour. Only new signups get the new treatment.
3. **School input: curated list first, free text as the escape hatch.** A searchable
   picker over a prebuilt list of institutions, with an explicit "add a school that
   isn't listed" path so nobody is blocked. Standardizes the overwhelming majority of
   values while keeping the field answerable by anyone.

4. **The field is optional, and blank claims nothing.** (Dawson, 2026-07-28.) A user who
   does not name a school gets no alumni and no school highlighting anywhere. Blank does
   not mean "not BYU" — it means the product has no basis for a school-based claim, so it
   makes none.

## The three affinity states

`hasAlumniAffinity()` is a boolean, but the *product* has three states, and conflating the
bottom two is how the copy goes wrong.

| School on file | Bundle | Highlighting | Copy posture |
|---|---|---|---|
| **BYU-family** | 2,000 | Full, exactly as today | Unchanged |
| **Named, non-BYU** | 1,112 | None | Explain: the database is BYU-sourced, so alumni-only contacts were filtered out |
| **Blank** | 1,112 | None | Invite: add your school and we will surface alumni connections |

The bottom two are identical in data and behaviour; they diverge only in what the user is
told. A named-school user has answered the question and deserves an explanation for the
smaller number. A blank user has not been asked anything yet, and the honest message is
the one that is also the recovery path.

Two consequences:

- **"Prefer not to say" comes out of the picker.** With an optional field, leaving it
  blank *is* the opt-out. A second way to express the same thing is clutter.
- **Item 47's deploy window becomes load-bearing.** `NULL` is now a legitimate permanent
  state ("didn't answer"), which makes it indistinguishable from the transient state
  ("was never asked, because the form did not have the field yet"). Anyone signing up in
  that window would silently land on the non-affinity path without ever being offered the
  question. The column default in item 47 is what keeps the two apart: window signups are
  grandfathered to BYU like every other pre-field account, and only post-deploy blanks mean
  "asked, declined."

## Design

### The seam: one affinity concept, one normalizer

Today the BYU test is copy-pasted in **five** places: `isByuSchoolName()`
(`company-queries.ts:48`), `isByuLikeSchool()` (`mcp/lib/dossier.ts:67`), and three
separate inline SQL predicates in `bundle_alumni_stats`, `bundle_company_stats`, and
`user_company_alumni_counts` — each carrying a comment that says it "mirrors" one of
the others. That is exactly the duplication that rots silently.

Collapse it to one concept and two implementations that are held in sync by a test:

- **`careervine/src/lib/schools/affinity.ts`** (new) — the single TS authority.
  - `normalizeSchoolName(name): string` — casefold, strip punctuation and `the`.
  - `isByuFamilySchool(name): boolean` — replaces both existing helpers.
  - `schoolsMatch(a, b): boolean` — does a contact's school match the user's?
  - `hasAlumniAffinity(user): boolean` — the one predicate every gate below asks.
- **`is_byu_family_school(text) → boolean`** (new, `IMMUTABLE`) — the single SQL
  authority; the three RPCs call it instead of inlining `LIKE` patterns.
- **A parity test** feeds a shared fixture list (`BYU`, `byu-idaho`, `Brigham Young
  University`, `BYU Marriott School of Business`, `Byui`, plus negatives like
  `Bryant University`, `Young Harris College`) through both and asserts identical
  verdicts. This is the guard that keeps the two from drifting.

### Denormalize the two raw facts onto `bundle_prospects`

Add two columns, written at publish time and backfilled in the migration:

- `is_alumni boolean NOT NULL DEFAULT false`
- `persona text` — today every stats RPC re-parses `payload->>'persona'`

Publish is the only writer of that table and always rewrites the payload, so neither
column can drift. Index the pair for the filter.

Deliberately **not** denormalized: an `alumni_only` flag. It is derivable from the two
facts above, and a derived-from-derived column is a second definition of the product
rule that can rot independently of the first. The rule lives in exactly one TS predicate
and one SQL expression, both named, both covered by the parity test.

This is what makes the sync filter cheap and stops the three stats RPCs from each
re-walking `jsonb_array_elements(payload->'education')`.

### Where the filter lives

The subscriber's affinity is resolved once per sync run and threaded through
`SubscriptionCore`. Both apply paths then skip ineligible prospects:

- **Merge path** (`bundle-sync.ts:426`) — filter the fetched rows in TS after the read.
  The cursor advances by the last row **read**, not the last row applied, so pagination
  stays correct and chunks simply apply fewer rows. Filtering in the PostgREST query
  instead would work too, but doing it in TS keeps one code path shared with the fast
  path and keeps the checkpoint semantics obvious.
- **Fast path** (`bundle-fast-apply.ts:runFastApplyStep`) — same filter, same place.
- **Removal phase** — no change needed. Skipped prospects never produced a
  `bundle_subscription_contacts` linkage row, so the removal lookup finds nothing and
  is already a no-op. *Verify with a test rather than by inspection.*

### School changes after signup

- **non-BYU → BYU**: reset `synced_version = 0` and clear `sync_cursor`. The existing
  resubscribe path already does exactly this ("Reset to 0 on resubscribe (idempotent
  full re-apply)"), so the alumni top-up rides machinery that is already proven.
- **BYU → non-BYU**: **never delete anything.** The 888 alumni-only contacts they already
  hold are theirs. Highlighting goes away because it is computed at read time; the
  contacts stay. Deleting real contact data on a profile edit is not a defensible
  behaviour, and the unsubscribe flow already exists for people who want them gone.

### Generalizing the badge — DECIDED, in scope (Dawson, 2026-07-28)

Settled by the abbreviation call below: per-school abbreviations only have a purpose if the
badge generalizes. Under plain suppression, BYU users would keep a hardcoded "BYU" and
everyone else would see nothing, so no other school's abbreviation would ever render.

The literal ask is "don't highlight BYU alumni for non-BYU users". But the same code
path, with the label made dynamic, gives a Utah State user a **"USU" badge on their own
contacts** — which is what "tailor their experience based on their school" actually
means, and is the difference between a feature and a subtraction. It costs the badge
components a prop and `is_alum` a comparison against the user's school instead of a
constant.

I have planned it in, scoped to the user's **own** contacts (never the bundle, which is
BYU-sourced and has no other school's alumni to find). Say the word and Phase 5 collapses
to plain suppression.

**Cost, verified.** `is_alum` is two clauses (`company-queries.ts:669-670`):

```ts
const isAlum = (p: PersonAgg) =>
  byuByContact.has(p.id) || (p.verified_school != null && p.verified_school !== "none");
```

- **Clause 1** reads free-text `contact_schools → schools.name` and generalizes cleanly to
  any school. **Every import path writes those rows** — `bulk-import.ts:694-699` flushes
  education for pipeline and bundle imports alike, and the extension and manual entry do
  the same. So clause 1 alone covers every contact that has a school on file.
- **Clause 2** is `contacts.verified_school`, pinned by CHECK to
  `('BYU', 'BYU-Idaho', 'Marriott', 'none')`
  (`20260707000000_company_pages_and_scrape_import.sql:93`, never altered). It exists as a
  human-verified override for pipeline records whose reviewer confirmed a BYU affiliation
  the scraped profile did not list (`scrape-mapper.ts:405`). It is BYU-only by construction.

**The actual defect if clause 2 is left alone:** a Utah State user who imports a contact
carrying `verified_school = 'BYU'` gets that person badged as **their USU alum**. Wrong,
and visible. The fix is one conditional — clause 2 counts only when the user is BYU-family
— **not** a migration relaxing the constraint.

> An earlier draft of this section claimed a generalized badge would be "silently absent on
> pipeline-imported contacts" and therefore required a migration. That was wrong: pipeline
> imports write `contact_schools` like everything else. Recorded because the wrong version
> was quoted to Dawson.

**Residual, not a blocker:** BYU-family users keep a second confirmation path nobody else
has, so their badge is marginally more complete. Another school's badge fires only when the
contact's profile actually lists it. That is a data-coverage difference, not a correctness
bug, and it is invisible to the user who only ever sees their own.

**The badge names the school, via a curated abbreviation.** (Dawson's call, 2026-07-28.)
Three surfaces hardcode the string "BYU" today: the chip itself
(`person-modal.tsx:101`, `pipeline-layout.tsx:712`, `outreach/page.tsx:403`), the company
card's "{n} BYU alumni in product" (`company-card.tsx:130,136`), and the onboarding picker's
"{n} BYU alumni" (`onboarding-flow.tsx:747`). Each takes the abbreviation for the *user's*
school.

**Where the table lives: static code, not the database.** An `abbr` field on each entry of
the curated list that item 8 already extends. The abbreviation is only ever needed for the
user's own school, which is always a list entry — contacts' scraped school names never need
one — so there is nothing to seed, nothing to query per badge render, and it works on the
signup form, which renders pre-session. Populated by hand: a bounded one-time pass over the
list, not a derivation. Derivation would be wrong anyway ("University of California,
Berkeley" is not "UCB"; "University of Michigan" has no single short form).

BYU-family entries carry distinct abbreviations per campus: `BYU`, `BYU-I`, `BYU-H`, and
"BYU Marriott School of Business" → `BYU`.

**Escape-hatch entries have no abbreviation**, since the user typed a school that is not on
the list. Fall back to **"Alum"** — it reads naturally beside chips that say "USU", and
avoids putting a truncated free-text string in a tiny chip. So: `abbr ?? "Alum"`, one rule,
no truncation logic.

Same fallback covers the counts: "{n} {abbr} alumni" becomes "{n} alumni" when there is no
abbreviation.

**Still in scope regardless** (item 29a): a non-affinity user must not see the persona chip
render `alum_product` as "Alum · Product". That is independent of how the school badge is
labelled — it is the 43%-of-the-bundle leak, not a wording collision.

This never touched the suppression half: `bundle-payload.ts:300` writes
`verified_school: null` for every bundle contact, so the 532 kept alumni are badged purely
through the school-name path that item 28 already covers.

### Who counts as BYU-family, stated as a decision

Today's helpers do `includes("brigham young") || startsWith("byu")` — fine when the input
was scraped contact data, not fine now that the input is the account holder's own answer
gating 44% of their product. The qualifying set is a product decision and belongs here,
not in a test fixture:

| Institution | Affinity | Why |
|---|---|---|
| Brigham Young University (Provo) | **Yes** | |
| BYU–Idaho, BYU–Hawaii | **Yes** | Same alumni network; the pipeline's own scrape config targets BYU + BYU-Idaho + Marriott |
| BYU Marriott School of Business | **Yes** | A college within BYU, and already a `verified_school` value |
| BYU–Pathway Worldwide | **Yes** | BYU-branded, shares the alumni identity |
| Ensign College | **No** | LDS-affiliated but not BYU; no shared alumni network |
| Utah Valley University | **No** | Heavy Provo overlap, unrelated alumni network — the tempting false positive |

The parity test enforces this table. Since the picker is a curated list, the cleanest
implementation is a flag on the list entry; the string normalizer then only has to handle
the free-text escape hatch.

### Users the plan must not assume away

- **Multi-school.** `users.university` is one column. A BYU undergrad with a Stanford MBA
  who types the more recent school loses 888 contacts they have a genuine claim to. Within
  a BYU-adjacent user base this is the likeliest miscategorization and the most expensive.
  **Resolution:** the picker accepts more than one school; affinity is true if *any*
  qualifies. One extra row in a join table, and it removes the whole class.
- **Non-US and non-traditional.** The existing autocomplete is US-only, so an
  international student, a bootcamp grad, or a community-college user hits the escape hatch
  on their first interaction with the product. The escape hatch must therefore be a
  first-class path with real copy, not an error state.
- **Non-students.** See items 34a/34b — the product asserts enrollment it cannot know.

## Work breakdown

### Phase 1 — Schema + normalizer

| # | Change |
|---|---|
| 1 | Migration: `users.university text` (nullable) + `users.university_is_custom boolean` (did they use the escape hatch? lets us fold popular customs into the list later) |
| 2 | Same migration: `UPDATE users SET university = 'Brigham Young University'` — the decision-2 backfill, with a comment explaining that it encodes the pre-CAR-213 assumption |
| 3 | Same migration: `GRANT UPDATE (university, university_is_custom) ON users TO authenticated`. Column-level grant is the gate; `users_update_own` already scopes rows to `auth.uid()`. **Do not touch the policy** — its `WITH CHECK` pins admin-only columns and a DROP+CREATE would have to re-list every one of them |
| 4 | `CREATE OR REPLACE FUNCTION public.handle_new_user()` — read `raw_user_meta_data->>'university'` into the new column. Must preserve the CAR-68 onboarding action-item insert in the same body |
| 5 | Migration: `bundle_prospects.is_alumni boolean NOT NULL DEFAULT false` and `persona text` + index + backfill from payload; publish path writes both |
| 6 | Migration: `is_byu_family_school(text)` `IMMUTABLE`; rewrite `bundle_alumni_stats`, `bundle_company_stats`, `user_company_alumni_counts` to call it and to read the two new columns instead of re-parsing jsonb |
| 7 | `src/lib/schools/affinity.ts` — the normalizer described above; delete `isByuSchoolName` and `isByuLikeSchool`, repoint all callers. Also home to `ALUMNI_ONLY` — the single TS statement of the exclusion rule, paired with one named SQL expression |
| 8 | **Extend the existing `src/components/ui/school-autocomplete.tsx`** — it already ships ~100 US universities including Brigham Young and is live at `contacts/page.tsx:897` and `contact-edit-modal.tsx:441`. Do **not** build a second list: a user who meets one school input on their profile and a different one on every contact they edit, with different coverage and different normalization, gets inexplicable matching. Lift its list into a shared module, widen it, and add the escape-hatch affordance as a prop. **Not** sourced from the `schools` table: that table is `schools_select_all USING (true)` and accumulates names scraped from every tenant's contacts, so using it as a suggestion source would surface cross-tenant data — and signup runs pre-session anyway, where a DB read needs an anon-readable endpoint that does not exist |
| 9 | `supabase gen types` → `database.types.ts` (types-drift is a CI gate) |

**Migration ordering (rule 42):** the app reads `users.university` the moment it deploys,
and merge auto-deploys within minutes. These columns are additive and nullable, so apply
the migration **before** merging — old code never selects them, and new code would hard-fail
against the old schema.

**Item 47 — the window that ordering opens.** Between the migration landing and the deploy
that captures the field, anyone who signs up gets `NULL`: item 2's backfill is a one-time
`UPDATE` inside the migration and has already run. They are not covered by the
existing-user decision and never get asked. Close it with a DB-level column default of
`'Brigham Young University'` for the duration, dropped once the deploy is live — or a
sweep immediately after. Width equals the merge-to-deploy gap, so this is minutes, but it
is silent and permanent for whoever lands in it.

### Phase 2 — Capture the school

| # | Change |
|---|---|
| 10 | `school-autocomplete.tsx` gains an "Add \"<typed>\"" row that stores the raw string and sets `university_is_custom`. No opt-out row: the field is optional, so blank is the opt-out. Both existing call sites keep today's behaviour via props |
| 10a | **Populate `abbr` on every curated list entry** — the one-time hand lookup Dawson signed off on. Bounded by the list size; no derivation. BYU-family entries get per-campus values (`BYU`, `BYU-I`, `BYU-H`; Marriott → `BYU`). Escape-hatch entries have none by definition and fall back to "Alum" |
| 10b | `abbrFor(user)` in `schools/affinity.ts` — resolves the user's school to its abbreviation or `null`. Every badge and count surface reads this one function rather than a constant |
| 11 | `auth-form.tsx` — the picker in `signup` mode, below the name row. Optional, per "a field where they **can** list their university" |
| 12 | `auth-provider.tsx:signUp()` — accept `university`, pass it in `options.data` alongside `first_name`/`last_name` so the trigger picks it up |
| 13 | `settings/account-section.tsx` — same picker, editable. Note the CAR-205 load-failure guard already in that file: the new field must follow the same "don't render the form over an unloaded read" discipline or it will overwrite a stored school with a blank |
| 14 | School-change side effects: on non-BYU → BYU, reset `synced_version`/`sync_cursor` for active subscriptions and kick a sync |
| 14a | **Confirm any affinity-crossing school change.** Today the save path produces only a "Saved" checkmark (`account-section.tsx:261`). Without a dialog, non-BYU → BYU silently drops 888 contacts into the CRM, and BYU → non-BYU makes badges vanish, company ordering shift, and next-action lines rewrite themselves with no explanation — which reads as a bug, not a setting. Reuse the shape of the existing unsubscribe modal (`data-subscriptions-section.tsx:318-360`), which already asks a comparable question well. Add a progress affordance for the top-up |
| 14b | **Admin PATCH allowlist** (`api/admin/users/[id]/route.ts:110-122`) currently permits `first_name`, `last_name`, `phone`, `email`. Add `university` — support cannot otherwise fix a field that gates 44% of the core offer, and a signup typo is unfixable by re-registering (`auth-provider.tsx:122-127` returns `existingAccount`, and the trigger's `ON CONFLICT DO NOTHING` would no-op anyway) |
| 14c | **Surface the control where its consequence is visible.** One line on the bundle card in `data-subscriptions-section.tsx` — "Tailored for {school} · Change" — linking to the account tab. Without it, a user who notices their badges look wrong has no path from symptom to setting |

### Phase 3 — Bundle sync

| # | Change |
|---|---|
| 15 | Thread affinity into `SubscriptionCore`; resolve it once per sync run (service-role client, all four drivers) |
| 16 | `bundle-sync.ts` apply phase — skip ineligible prospects |
| 17 | `bundle-fast-apply.ts` — same filter |
| 18 | Test that the removal phase is a genuine no-op for never-applied prospects |
| 19 | `checkFastApplyEligibility` needs no logic change, but its batch-size assumptions get a test at 1,112 prospects (still a two-call fast apply at `FAST_APPLY_BATCH = 1000`) |

### Phase 4 — Onboarding must stop quoting BYU numbers

| # | Change |
|---|---|
| 20 | `lib/onboarding/bundle-stats.ts` — add `eligibleProspectCount`; return alumni counts only under affinity |
| 20a | **Tell the non-BYU user why their experience differs.** Phase 4 makes every number *accurate*; accurate is not honest. They see "1,112 prospects" with no idea a BYU user sees 2,000, that the database is BYU-sourced, or that their own answer changed it — so they cannot self-diagnose, compare notes with a friend, or evaluate the offer. One sentence in the offer step reframes a subtraction as curation. Exact copy in the deck below |
| 21 | `onboarding-flow.tsx:224-236` — the offer copy ("1,420 BYU alumni among 2,000 prospects") becomes school-aware |
| 22 | `onboarding-flow.tsx:666` — **the progress bar.** `total = stats.prospectCount` (2,000) against 1,112 actually applied means the bar caps at 56% and the "N of 2,000 added" line never completes. Must use `eligibleProspectCount` |
| 23 | `onboarding-flow.tsx:673` — "Companies with BYU alumni are at the top" |
| 24 | `onboarding-flow.tsx:741-753` — per-company alumni badges |
| 25 | `lib/onboarding/company-picker.ts` — drop the two alumni sort options and change the default sort key when there is no affinity; `toPickerCompanies` currently hardcodes `"alumni"` |
| 26 | `bundle_company_stats` call site — needs the eligible prospect count so the 12 emptied companies are filtered out rather than shown as "0 contacts" |
| 27 | Analytics: `onboarding_company_picked` sends `alumni_count`; add the school dimension so the funnel is separable |
| 27a | **`settings/data-subscriptions-section.tsx` — the second bundle surface, missed in the first pass.** This is the *only* subscribe path for anyone who declined during onboarding, and it ships three defects: `:124` toasts "`{prospect_count}` prospects added to your contacts" (**says 2,000 when 1,112 landed** — a checkable falsehood at the moment of the action), `:121`/`:274` reproduce the identical progress stall from item 22, and `:257-260` advertises 2,000 prospects / 99 companies to a user receiving 1,112 / 87. Same `eligibleProspectCount` treatment throughout; the toast must name what was actually delivered |
| 27b | **Name the non-affinity default sort.** Item 25 says "change the default" without saying to what. `toPickerCompanies` hardcodes `"alumni"` (`company-picker.ts:88`) and the two alumni options are *user-visible dropdown labels* ("Most BYU alumni", "Most alumni in product roles"). Default to `contacts`, and rewrite the picker subtitle — "warmest door in" no longer describes the ordering |

### Phase 5 — Highlighting

| # | Change |
|---|---|
| 28 | `company-queries.ts` — `is_alum`, `alum_count`, `product_alum_count`, and the `byAlumThenPersona` sort become affinity-aware |
| 29 | Badge components: `company-card.tsx:127-138`, `person-modal.tsx:99`, `pipeline-layout.tsx:710`, `outreach/page.tsx:401` |
| 29a | **The persona chip, which keeps the highlighting alive on 43% of the bundle.** Two to three lines *above* each badge in the same three files sits a byte-identical `PERSONA_LABELS` map (`outreach/page.tsx:31-32`, `person-modal.tsx:21-22`, `pipeline-layout.tsx:69-70`) rendering `alum_product` as **"Alum · Product"**. 474 of the 1,112 kept prospects are `alum_product`, so a non-BYU user opens their pipeline to find 43% of their database chipped "Alum" — of *what*, with the only natural reading being false. Suppressing the BYU badge while leaving this is the fix missing its own target. Without affinity, `alum_product` renders as "Product". Fold the three copies into one exported map while in there |
| 30 | `company-filter-bar.tsx:134-141` + `lib/company-filters.ts` — the "BYU alum in product" chip. Also clear a persisted `productAlum` URL filter for a non-affinity user, or they get a filter they cannot see or turn off |
| 31 | `company-next-action.ts:135-145` — "Reach out to X, your BYU alum in product" |
| 32 | `home/unified-action-list.tsx:274,281` — two getting-started subtitles |
| 33 | `mcp/lib/dossier.ts` — `is_byu_alum` in the dossier identity block and `"BYU alum."` in the summary. **Contract change**: rename to `is_school_alum` (or drop) and update `mcp/tools/contacts.ts:149` + `mcp/tools/outreach.ts:108` descriptions |

### Phase 6 — Email templates

| # | Change |
|---|---|
| 34 | `lib/onboarding/templates.ts` — the alumni variant is gated on affinity, **and the non-alumni variant stops saying "a student at BYU"** (line 86). This is the sharpest live bug in the set: it puts a false claim in a real user's outgoing email. Both variants become school-aware. Subject lines carry it too: `:71` and `:82`. Exact strings in the copy deck below |
| 34a | **Drop the enrollment claim, not just the school.** Every variant asserts the sender is "a student", which the product has no basis for — CareerVine models student-vs-professional status precisely for *contacts* (`extension-contract.ts:88`) and not at all for the account holder. A career changer, an MBA grad, or anyone two years out sends a first email that misrepresents them, in the highest-stakes moment the product has. "I'm working toward a career in product management" is true for everyone and costs nothing |
| 34b | **The two AI routes assert it as well** and are absent from the first pass: `api/ai/draft-intro/route.ts:37` opens `You are helping a college student write a professional networking email` (reinforced at `:50`), and `api/ai/draft-follow-ups/route.ts:27` does the same (`:29`, `:69`). Same neutralization. Pre-existing rather than introduced here, but it is the same false-identity class and lands in the same PR |
| 35 | `companies/[id]/page.tsx:136` template selection + `:189` "BYU alumni get the alumni version" cue copy |

### Phase 7 — Docs and copy drift (same PR, per CLAUDE.md)

| # | Change |
|---|---|
| 36 | `public/docs/index.html` — 6 spots (lines 601, 603, 605, 790, 791, 794) |
| 37 | `README.md` — lines 17 and 25 |
| 38 | `privacy/page.tsx` — "Account Information" must now name the university field. Google and the Chrome Web Store audit this against actual behaviour |
| 39 | `CONVENTIONS.md` — a pointer to `schools/affinity.ts` as the single authority, if the section index warrants it |

### Phase 8 — Tests

18 test files reference BYU today and all need updating. But the test *shape* matters more
than the list, because of one property of this change:

> **Almost everything worth asserting here is an absence.** "No BYU string renders." "This
> prospect was not applied." "No badge appeared." Absence assertions pass **vacuously** — a
> component that throws, a render that produces nothing, a query that returns empty all
> turn every one of them green while proving nothing. This has already cost this project
> twice (CAR-191, CAR-200).

Every rule below exists to defeat that.

**Available tiers:** unit (`npm run test`), integration against real Postgres
(`npm run test:integration`), Playwright E2E (`npm run test:e2e`). Sweep-style guards have
precedent here — `data-mutation-guards`, `storage-sweep`, `cron-schedules-registry`.

#### 8.1 The leak dragnet — one test, not twenty

Render **every** affected surface for a non-affinity user and scan the output for
`/byu|brigham|cougar/i`. One test, all surfaces.

The point is that it catches surfaces **nobody remembered to list** — which is the actual
failure mode here: the PM audit found three (the persona chip, the second subscribe screen,
the AI prompts) that a hand-enumerated per-component suite would have missed by construction.

**It must carry a positive control in the same file:** the identical render for a BYU-family
user must *find* the string. Without that half, a dragnet over a broken render is green and
meaningless.

**Honest limit:** it catches strings, not behaviour. A badge rendering for the *wrong
contact* says nothing about BYU and sails through. That is what 8.3 and 8.4 are for.

#### 8.2 Every absence assertion carries its positive control

Not two tests — one test, one render path, both halves:

```
it("badges the user's own school, and only that", () => {
  // affinity user   → expect(badge).toBeInTheDocument()   ← fails if render is broken
  // non-affinity    → expect(badge).not.toBeInTheDocument()
})
```

A vacuous render fails the first assertion, so the second can no longer lie.

#### 8.3 Parity — one fixture through two engines

The anti-drift guard, and the reason the `affinity.ts` seam exists at all. **Not** "test the
TS, then test the SQL": one fixture array of school names and expected verdicts, run through
`isByuFamilySchool()` **and** through `is_byu_family_school()` in the integration tier
against real Postgres, asserting agreement row by row. Separate tests of each prove nothing
about the thing that actually breaks, which is the two drifting apart.

Fixture covers the decision table in "Who counts as BYU-family": BYU, BYU-Idaho, BYU-Hawaii,
Marriott, Pathway as positives; Ensign College, Utah Valley University, Bryant University,
Young Harris College as negatives.

#### 8.4 Exact counts, never `> 0`

A fixture bundle of known composition applied to both subscriber types. Non-affinity receives
**exactly** N, affinity **exactly** M. `> 0` passes when 1 of 7 lands.

#### 8.5 The four boundary rows that *are* the rule

| Prospect | Expected |
|---|---|
| Alum, product-role persona | **kept** |
| Alum, `recruiter` | **kept** |
| Alum, neither | **dropped** |
| Alum, `persona = null` | **kept** — fail safe |

If any one flips, the product is wrong. These get written **before** the filter code.

#### 8.6 Both sync paths, parameterized

The filter lives in the merge path **and** `bundle-fast-apply`. `describe.each` over both, so
the assertions cannot be written once and silently cover only one. Which path runs depends on
eligibility conditions a test can otherwise satisfy by accident.

#### 8.7 The progress bar reaches 100%

Assert `applied / total === 1` at completion for a non-affinity user — **not** that `total`
equals some number. Asserting the value re-encodes the bug; asserting convergence catches it.
Covers both the onboarding flow and `data-subscriptions-section`.

#### 8.8 Everything else, same discipline

- Removal phase is a no-op for never-applied prospects
- non-BYU → BYU triggers a full re-apply; BYU → non-BYU deletes **nothing** (count contacts
  before and after)
- Both email templates and both AI system prompts: no school and no enrollment claim leaks
  into a non-affinity user's outgoing mail
- Signup writes the school through the trigger; the escape hatch sets `university_is_custom`
  and renders the "Alum" fallback rather than a truncated name
- The three affinity states each resolve to their own copy variant (named-BYU, named-other,
  blank) — blank must not silently reuse the named-other explanation

#### 8.9 Migration proven against real schema

Rule 32: execute against production inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;`.
`supabase db push --dry-run` only lists what would run; it never executes SQL and cannot
catch a reference to a dropped column.

#### 8.10 Falsification, per phase, not at the end

For every test kept: patch the fix out, confirm **that specific test** goes red, restore.
A test that stays green with the fix removed is measuring nothing.

Commit before probing. Per CAR-200, `git checkout -- <file>` restores from the *index* and
discards all uncommitted work in that file — it wiped three files mid-session during exactly
this kind of sweep. A WIP commit is free and amendable; a scratchpad copy also works.

#### Written before the code

8.3 and 8.5 are the specification, not verification of it. They land first.
8.1 lands immediately after Phase 5 and re-runs after every later phase.

## Copy deck

The largest omission in the first draft. This change is ~80% copy, and "becomes
school-aware" is not a specification. Every user-visible string, written out. No em dashes
(rule 35).

**Signup / settings picker**

| Element | Copy |
|---|---|
| Label | Where do you go (or did you go) to school? (optional) |
| Helper | We use this to tailor which contacts and intro emails you get. |
| No match | No match. Pick "Add [typed]" to use it anyway. |
| Escape hatch row | Add "{typed}" |

No opt-out row: the field is optional, so leaving it blank *is* the opt-out.

**Bundle offer, blank-school user** — the invite, not the explanation:

> Get our curated {name} database: **1,112 prospects** at 87 companies that hire new-grad PMs.
>
> Add your school in Settings and we will surface the alumni connections in it too.

**Alum badge and counts** — `{abbr}` is the user's own school's abbreviation from the
curated list. Escape-hatch schools have none, so the fallback column applies.

| Surface | With abbreviation | Escape-hatch fallback |
|---|---|---|
| Chip (3 files) | 🎓 {abbr} | 🎓 Alum |
| Company card | {n} {abbr} alumni in product | {n} alumni in product |
| Company card | {n} {abbr} alumni | {n} alumni |
| Onboarding picker | {n} {abbr} alumni | {n} alumni |
| Persona chip, `alum_product`, non-affinity | Product | Product |

**Bundle offer, non-affinity user** (`onboarding-flow.tsx:222-238`)

> Start with a network, not an empty page
>
> Get our curated {name} database: **1,112 prospects** at 87 companies that hire new-grad
> PMs, including product leaders, PMs, and recruiters you can actually reach.
>
> This database was built around BYU's alumni network, so we have filtered out the
> alumni-only contacts. They are not a warm door for you, and we would rather hand you 1,112
> people worth emailing than pad the number.

**Subscribe toast, non-affinity user** (`data-subscriptions-section.tsx:124`)

> Subscribed to {name}: 1,112 prospects added to your contacts

**Company picker subtitle, non-affinity** (`onboarding-flow.tsx:672-675`)

> Companies with the most contacts are at the top. You can add more targets anytime.

**Sort dropdown** (`company-picker.ts:38-43`) — non-affinity users see only "Most contacts"
and "Alphabetical". The two alumni options are hidden, not disabled.

**Intro email, non-affinity** (`templates.ts:82-88`) — school and enrollment both dropped:

> Subject: Interested in product at {company}
>
> Hi {first_name}, I'm {sender}, working toward a career in product management, and your
> role at {company} stood out while I was researching teams whose work I admire.

**Intro email, affinity** (`templates.ts:71-77`) — school parameterized, enrollment dropped:

> Subject: {School} connection who would love to hear about your path to {company}
>
> Hi {first_name}, I'm {sender}, working toward a career in product, and it was genuinely
> encouraging to find a fellow {school} alum at {company}.

**School-change confirmation** (item 14a)

> Changing to {new school} adds about 888 contacts to your CRM from the alumni database.
> They will appear over the next few minutes.

> Changing to {new school} removes the alumni highlighting from your contacts. Nothing is
> deleted: every contact you have stays exactly where it is.

**Persona chip, non-affinity** (item 29a) — `alum_product` renders as "Product".

**Bundle card affordance** (item 14c) — "Tailored for {school} · Change".

## Success metrics

Item 27 adds one analytics dimension; that is instrumentation, not a definition of success.

1. **Primary — does the 56% bundle still convert?** Signup → first-email-sent completion
   rate, split by affinity. If non-affinity completion trails affinity by more than a few
   points, the offer copy or the picker default is the suspect, not the filter.
2. **Field fill rate and escape-hatch rate.** If the escape hatch is taking a large share,
   the curated list does not cover the real user base. That is the trigger to widen it.
3. **Distribution of `university_is_custom` values.** The column exists precisely to fold
   popular customs into the list. Set the threshold now: any custom value appearing 5+ times
   gets promoted at the next release.
4. **Company-picker abandonment, non-affinity.** Their default sort is no longer "warmest
   door in", so this is where a worse experience would first show up.
5. **Guardrail — affinity misclassification.** Any BYU user who lands on the non-affinity
   path is a normalizer bug. Watch for school-field edits within 7 days of signup.

## Rollout

No flag, no phasing, no kill switch in the first draft, for a gate that simultaneously
touches badges, sorts, filters, next-actions, the picker, the sync, and outgoing email.

- **Ship behind an env-gated affinity kill switch** that forces `hasAlumniAffinity` to
  `true` for everyone. That restores today's behaviour exactly, which is what the backfill
  makes safe, and is the one lever available if the normalizer misfires and real BYU
  students start getting the stripped experience.
- **Existing users are a no-op by construction** (backfilled to BYU), so the blast radius on
  day one is new signups only. Verify by watching the affinity split on new accounts before
  removing the switch.
- **The filter is not retroactive.** An existing subscriber's already-synced contacts are
  never re-evaluated. This is intentional (never delete), but state it so nobody reads the
  unchanged contact counts on live accounts as a bug.

## Non-goals

Stated so the Phase 5 generalization does not quietly grow into a platform:

- **Not** multi-school bundle support. Affinity is one boolean gate on one BYU-sourced
  bundle, not a per-school data marketplace.
- **Not** a general school-affinity system for third parties.
- **Not** a change to how contacts' schools are captured, resolved, or deduped.
- **Not** a repositioning of the product away from BYU. The bundle stays BYU-sourced; this
  ticket only stops the product from assuming its users are.

## Risks

1. **The 56% bundle is the product for non-BYU users.** 1,112 prospects across 87
   companies, no bench tier, 12 companies empty. It is a genuinely strong offer — every
   PM, product leader, and recruiter survives — but the onboarding copy currently sells
   the alumni angle as the whole value proposition. The copy work in Phase 4 is not
   cosmetic; it is what keeps the offer honest.
2. **Migration ordering.** Phase 1 must land before the merge (rule 42). Additive
   nullable columns make this safe, but PostgREST returns `{data: null}` without throwing
   on a missing column, and the null-guards in this codebase misread that as "absent".
3. **The dossier contract change** (item 33) is consumed by an external MCP client.
   Renaming `is_byu_alum` is the right call but it is a breaking field rename.
4. **`schools` is a shared, write-open table.** Not used as the picker source for that
   reason (item 8), but worth remembering if anyone later reaches for it.

## Verification

- `npm run test` and `npm run build` from `careervine/`, plus `npm run check:conventions`
  (a CI gate that CLAUDE.md's verify list omits)
- Migration validated by executing it against production inside
  `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` — rule 32; `--dry-run` proves nothing
- Manual pass on a fresh non-BYU signup: bundle applies to completion with a progress bar
  that reaches 100%, no BYU string anywhere in the UI, and a first outreach email that does
  not claim they attend BYU
