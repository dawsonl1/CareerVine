# CAR-268 — Company detail page survives the trip to a contact and back

Opening someone from a company's roster and pressing back re-runs the whole load.
That is the most repeated movement on the page (read the roster, open a person,
come back, open the next), so the wait is paid over and over.

The flow is a real route change: `pipeline-layout.tsx:709` and `:862` do
`router.push('/contacts/<id>')`, and the contact page's back button calls
`router.back()` when `hasInAppBackHistory()`, so the return is a popstate. Both
the cache and the scroll restoration CAR-256 shipped can engage.

## The decision that shapes this: cache the roster, always refetch the pipeline

`load()` awaits two independent reads. They have opposite risk profiles:

- **`fetchCompanyScopes`** is the expensive one and is READ-ONLY on the page. It
  fans out to `getContactStages`' eight legs plus the alumni and email reads.
- **`loadPipeline`** is small (one company's `target_companies` row plus five
  `pipeline_*` tables) and is the MUTABLE half: `usePipelineAutosave` seeds a
  reducer from it (`use-pipeline-autosave.ts:100-132`) and writes back on an
  800 ms debounce.

Caching the pipeline is what makes this dangerous, and it buys the least. The
audit found a concrete bug it would introduce: the autosave's unmount flush
(`use-pipeline-autosave.ts:227-236`) writes AFTER the cache entry was stamped, so
typing a research note and clicking a contact inside the debounce window means
the note is gone from the screen on return while present in the database, then
reappears later from an uncached load. It also widens a cross-mount save race,
because an instant cache hit no longer waits on the network the way `load()` did.

So: **cache `fetchCompanyScopes` only.** Nothing mutable is ever restored from
cache, which deletes that entire failure class rather than guarding it. The
pipeline refetches every mount, exactly as today.

## Progressive render, which is what makes that choice work

Refetching the pipeline only helps if the roster does not wait for it. Today the
page gates everything behind one condition (`page.tsx:184`):

    if (loading || !company || !tabs || !state) return <skeleton />

That becomes: render as soon as `company` and `tabs` are ready (instant on a
cache hit), and let the pipeline column carry its own skeleton until `state`
arrives.

The split is already clean in the component. `PipelineLayout` consumes `state` in
exactly three places, all feeding the right-hand column:
`const { companyTargeted, officeTargeted } = state` (`:1337`), `scopeState`
(`:1338`), `cycleForm` (`:1339`). The left column (DiscoveryCard, the Contacts
roster, BenchSection) never reads it. So `state` becomes
`PipelineState | null`, the three derivations become null-guarded, and
`<RecruitingPanel>` (`:1530`) renders a skeleton while null.

## Invalidation

Same rule as CAR-256: invalidate at the WRITE SITE, never over `ui-events`, since
the cached view is unmounted when the write happens.

**Prefix-wide, not per-company.** A contact holds roles at several companies and
no contact-level write site knows which company pages that person appears on.
Invalidating only the company you came from leaves every other cached company
serving a contradicted roster. `invalidateListsByPrefix` already does this; the
list cache made the same call for the same reason.

`src/lib/company-detail-cache.ts` gets `companyScopesKey(userId, companyId)`,
`companyScopesKeyPrefix(userId)`, and `invalidateCompanyScopes(userId)`.

Write sites, from the audit. Each makes the cached roster contradict something
the user just did:

| Site | What it changes |
|---|---|
| `contact-edit-modal.tsx` Save | replaces `contact_companies`, `contact_schools`, `contact_emails`; can mint a target row |
| tier moves (`contact-profile-card.tsx`, contacts list, this page) | `contacts.network_status`, a hard bucket boundary |
| timeline exclude/restore (`timeline-detail-modal.tsx`) | `is_excluded` on emails, meetings, calendar events, interactions, all filtered by stage derivation |
| compose send/schedule | `email_messages` + `interactions`; flips not-contacted to contacted |
| `markEmailVerified` from compose | clears the "guessed" email badge |
| contact deletion | roster keeps a person whose link 404s |
| conversation logged/edited/deleted | moves the stage to call scheduled or call done |
| inline email edit on the profile card | rewrites `contact_emails`, dropping `bounced_at` |
| discovery card Add | creates a contact AT THIS COMPANY |
| pipeline autosave | `syncScopeStatus` writes `target_companies.status`, which IS in the cached scopes |

The last one matters even though the pipeline is not cached: the scopes are, and
they carry the target status. The seam already exists, at
`use-pipeline-autosave.ts:208` and `:250`, where `invalidateCompaniesList` is
already called.

Two sites already call `load()` (tier moves `page.tsx:170`, manage offices
`page.tsx:244`). They must call the hook's `reload()`, which bypasses the cache
AND rewrites the entry on success; a plain re-run would serve the entry it just
contradicted.

## Explicitly out of scope, with reasons

- **LinkedIn re-scrape** writes asynchronously via the Apify webhook with no
  signal back to the browser. There is no site to invalidate from; the TTL is the
  only bound, by construction.
- **Crons, Gmail/calendar sync, and MCP writes** are other processes. Sync is
  reachable as "company → inbox → Refresh → back", which the TTL bounds.
- **`referrals` and `target_company_notes`** cannot go stale: the audit found
  zero write sites for either in `src/`.

## Two pre-existing bugs found, not fixed here

Both predate this change and neither is caused by it. Recording them so they are
not mistaken for regressions:

1. The discovery card's Add splices only its own local list and never refreshes
   the roster, so a newly added person is already missing today.
2. `compose-email-modal.tsx:991/998` calls `/api/contacts/[id]` and
   `/api/contacts/[id]/note`; neither route exists. Both are swallowed by empty
   catches. Gated on `isIntro`, so it is latent on the intro path.

## Verification

- Unit: the new cache key/invalidation module; a page test that a warm scopes
  cache renders the roster with no scopes fetch while the pipeline still loads.
- `PipelineLayout` with `state: null` renders the roster and a pipeline skeleton,
  and does not throw on the three null-guarded derivations.
- E2E: company → contact → back keeps the roster with no refetch of the scopes
  read; and a write on the contact page (tier move) DOES refetch on return. That
  second one is the assertion that proves invalidation, and it is the one a
  cache-only test would miss.
- Full local set: `npm run test`, `vitest --coverage` (the gate CI runs and the
  local list omits), `test:integration`, `check:conventions`, `eslint`, `tsc`,
  `build`, `playwright test`.
