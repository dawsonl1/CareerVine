# CAR-5: Data Subscriptions (Subscribable Prospect Lists & Company Bundles)

> On implementation start: copy this plan into the repo at `.claude/plans/` with the next
> two-digit sequential prefix (per repo convention).

## Context

CareerVine is being readied for use by other students preparing for investment banking
recruiting. A new user starts with an empty account and no scraping pipeline — the biggest
onboarding gap. CAR-5 closes it with **admin-curated data bundles**: packaged sets of
prospects (IB analysts/associates) and companies-with-locations (banks and their offices)
that any user can subscribe to from a new **Settings → Data subscriptions** tab. Dawson
assembles bundles offline (with Claude Code) from Apify scrape pipeline outputs; there is
no in-app authoring UI.

## Locked product decisions (Dawson, 2026-07-08)

1. **Authoring**: admin-only, offline via script — no authoring UI.
2. **Copy on subscribe**: bundle prospects are physically imported into the subscriber's
   `contacts` as `network_status='prospect'` rows through the existing merge engine.
3. **Living subscription, silent auto-apply**: published updates flow to subscribers in
   the background with fill-empty-fields-only merge; user edits are never overwritten.
4. **Dedupe**: merge fill-empty-only; contacts keyed on canonical LinkedIn URL /
   `public_identifier`, companies via the `findOrCreateCompany` identity chain.
5. **Unsubscribe**: dialog asks **"keep all" vs "remove untouched"**.
6. **Companies stay ambient**: bundle companies/locations land only in the global shared
   tables; `target_companies` is untouched.

## Design-audit history

**Self-audit round** (adopted): CareerVine-owned versioned payload contract (not raw Apify
records); deterministic fingerprints instead of timestamp heuristics; publish-triggered
QStash fan-out instead of daily-cron-only; copy-on-subscribe reaffirmed over reference
model.

**Independent adversarial review round** (adopted — items below are load-bearing):
- **B1. Multi-bundle overlap**: fingerprint/touched state lives per `(user, contact)` in
  `bundle_contact_state` (NOT per subscription); contact deletion always requires that no
  other active subscription links the contact. Bundle mode never deletes scraped
  employment rows it didn't supply (prevents two bundles thrashing each other's rows).
- **B2. Committed-version gating**: delta queries are bounded above by the bundle version
  pinned at sync start (`version_updated > synced_version AND version_updated <=
  pinnedVersion`, same for removals); `synced_version` advances only to `pinnedVersion`,
  never a re-read value. `beginPublish` takes a publish lock (conditional-UPDATE claim of
  `staging_version` on the bundle row) so overlapping publishes are rejected. Staged
  (unfinalized) new rows can never be applied.
- **S3. Sync serialization + crash-safe fingerprints**: per-subscription atomic claim
  (`sync_claimed_until`) respected by all drivers (fan-out worker, cron, opportunistic,
  user-driven apply); post-apply fingerprint computed from the pre-snapshot + merge
  results (no DB re-read → no TOCTOU); interrupted applies detected via in-flight marker
  and recovered by refreshing the fingerprint WITHOUT promoting drift to touched.
  Fingerprint has an explicit field allowlist excluding importer-written fields
  (`photo_url`, `last_scraped_at`, provenance).
- **S4. Merge policy parameter**: the stock engine is NOT fill-empty-only (it overwrites
  `headline`, provenance, `review_note` unconditionally — verified in
  `scrape-merge.ts:201-244`, `bulk-import.ts:481`). Bundle mode = strict fill-empty for
  all contact fields, provenance stamped on create only, additive employment (no
  deletions), photo phase disabled until CAR-24 mirroring.
- **S5. Tombstone-on-delete ships in this build**: in-app deletion of a bundle-linked
  contact writes a `suppressed_imports` tombstone, else silent sync resurrects deleted
  contacts (day-one bug under auto-sync).
- **S6. Linkage RLS hardening**: INSERT/UPDATE `WITH CHECK` that the `contact_id` belongs
  to `auth.uid()`; every service-client write scoped by the subscription's `user_id`.
- **S7. Durable removal key**: linkage rows store `bundle_prospect_id` + canonical
  `linkedin_url` so removal correlation survives URL rewrites/edits.
- Smaller adopted items: bundle content SELECT restricted to active subscribers;
  read-side `payload_schema_version` skip-and-report; zero-change finalize skips the
  version bump and fan-out; fan-out batches subscribers per QStash message with flow
  control; partial index on `removed_in_version`.

## Foundations being reused (verified)

- `companies`, `locations`, `company_locations` are already **global shared tables** — no
  new sharing model needed.
- Merge engine: `careervine/src/lib/bulk-import.ts` (`importPeopleChunk`, ≤50/chunk,
  idempotent, checks `suppressed_imports`), `careervine/src/lib/scrape-merge.ts` (pure
  merge planners), `careervine/src/lib/scrape-mapper.ts`,
  `careervine/src/lib/company-helpers.ts`, `careervine/src/lib/linkedin-url.ts`.
- API convention: thin `route.ts` + `withApiHandler` + Zod in `api-schemas.ts`; logic in
  testable `lib/` helpers; Vitest mock-Supabase pattern
  (`careervine/src/__tests__/import-route.test.ts`).
- Async jobs are **Upstash QStash** (NOT Vercel cron):
  `careervine/src/app/api/cron/send-follow-ups/route.ts` shows Receiver.verify +
  `createSupabaseServiceClient()`.
- Settings tab pattern: `tabs` array in `careervine/src/app/settings/page.tsx` + section
  component in `careervine/src/components/settings/` (model: `integrations-section.tsx`).
- No admin/role primitive exists or is added — publishing uses the service-role client
  behind a secret-token route. `database.types.ts` is hand-maintained.

---

## 1. Bundle payload contract — `careervine/src/lib/bundle-payload.ts`

`BundleProspectPayloadV1` (Zod, CareerVine-owned): identity (`linkedin_url` canonical,
`public_identifier`), name, headline, `photo_url` (stable field; publish-time mirroring is
a CAR-24 drop-in), location `{city,state,country}`, `experiences[]` (company identity:
`linkedin_company_id`/`linkedin_url`/`universal_name`/`name`, title, start/end month,
is_current, location, workplace_type, employment_type), `education[]`, `emails[]`
(`{email, source}` ∈ pattern_guessed|scraped|verified), `tags[]`.

- Publish validates every prospect (reject chunk on failure). Read side: rows with an
  unknown `payload_schema_version` are skipped and reported, never crash a sync loop.
- `payloadToImportInput()` converts payload → importer input with bundle provenance and
  the bundle merge policy. Apify→payload conversion lives only in the offline publish
  script.
- Company entries mirror `targetCompaniesBulkImportSchema` fields +
  `offices: [{city,state,country}]`.

## 2. Migration — `supabase/migrations/20260709000000_data_bundles.sql`

Six new tables (integer identity PKs, house style):

- **`data_bundles`**: `slug UNIQUE`, `name`, `description`, `version int DEFAULT 0`,
  `staging_version int` (publish lock: claimed via conditional UPDATE where NULL or
  stale, cleared by finalize/abort), `status` ('draft'|'published'|'archived'),
  `prospect_count`/`company_count`, `published_at`, timestamps.
- **`bundle_prospects`**: `bundle_id FK CASCADE`, `linkedin_url` (canonical), `payload
  jsonb` (validated V1), `payload_schema_version int NOT NULL DEFAULT 1`, `payload_hash`,
  `version_added`, `version_updated`, `version_last_seen`, `removed_in_version` (NULL =
  live). `UNIQUE (bundle_id, linkedin_url)`; index `(bundle_id, version_updated)`;
  partial index on `removed_in_version WHERE NOT NULL`.
- **`bundle_companies`**: `bundle_id`+`company_id` links (display/provenance only).
- **`bundle_subscriptions`**: `user_id`, `bundle_id`, `status`
  ('active'|'unsubscribed'), `synced_version int DEFAULT 0`, `last_synced_at`,
  `sync_claimed_until timestamptz` (serialization claim). `UNIQUE (user_id, bundle_id)`;
  resubscribe flips status + resets `synced_version=0`.
- **`bundle_subscription_contacts`** (membership linkage — NO touched state here):
  `subscription_id FK CASCADE`, `contact_id FK CASCADE`, `bundle_prospect_id FK`,
  `linkedin_url` (canonical at apply — durable removal key), `created_by_bundle boolean`,
  `first_applied_version`, `last_applied_version`, `last_applied_at`.
  `UNIQUE (subscription_id, contact_id)`, index on `contact_id`.
- **`bundle_contact_state`** (per-user-per-contact — shared across ALL of a user's
  subscriptions): `user_id`, `contact_id FK CASCADE`, `applied_fingerprint text`,
  `user_touched boolean NOT NULL DEFAULT false` (sticky), `apply_started_at timestamptz`
  (in-flight marker for crash recovery), `updated_at`. `UNIQUE (user_id, contact_id)`.

**Why linkage + state split**: `import_meta` can't carry create-vs-merge state (set only
on the create path), so linkage rows are required; and one contact has ONE fingerprint
baseline and ONE touched flag no matter how many bundles supply it, so that state must
be keyed `(user, contact)` or overlapping bundles poison each other.

**Versioning** (single monotonic int per bundle): publish targets
`staging = version + 1` under the publish lock; finalize marks unseen prospects
`removed_in_version = staging`, recomputes counts, sets `version = staging`, clears the
lock — and **skips the bump + fan-out entirely when nothing changed**. Subscriber delta
at sync start pins `pinnedVersion = bundle.version` and selects
`version_updated > synced_version AND version_updated <= pinnedVersion AND
removed_in_version IS NULL` (removals analogous). `synced_version` advances only to
`pinnedVersion`. Interrupted anything degrades to re-apply — merge is idempotent, and
fingerprint recovery is drift-safe (§5).

**RLS**:
- `data_bundles`: SELECT for authenticated where `status='published'`.
- `bundle_prospects` / `bundle_companies`: SELECT only for users with an **active
  subscription** to the bundle (EXISTS on `bundle_subscriptions`) — bundle contents
  (emails!) are not a free harvest surface. Browse cards need only `data_bundles`
  columns. No write policies at all (service role only).
- `bundle_subscriptions`: per-user, all ops (`user_id = auth.uid()`).
- `bundle_subscription_contacts`: per-user via parent subquery; INSERT/UPDATE
  additionally `WITH CHECK (EXISTS (SELECT 1 FROM contacts c WHERE c.id = contact_id AND
  c.user_id = auth.uid()))` — a client must not be able to point linkage at another
  user's contacts.
- `bundle_contact_state`: `user_id = auth.uid()`, all ops.

Also: hand-add all six tables to `careervine/src/lib/database.types.ts`.

## 3. Import-machinery extensions (backward-compatible)

In `bulk-import.ts` / `scrape-mapper.ts`:
- Expose `contact_id` on `PersonImportResult` (create and update paths).
- Accept pre-mapped person input alongside raw records.
- **Merge policy parameter** (`mergePolicy: 'pipeline' | 'bundle'`), default 'pipeline'
  (existing behavior, zero change for current callers). 'bundle' =
  - strict fill-empty on ALL contact fields (headline included; no unconditional
    overwrites), `linkedin_url` upgraded only from non-canonical → canonical;
  - provenance (`import_source='bundle:<slug>'`, `import_meta.bundle_*`) stamped on
    create only — never clobbers existing provenance on merge;
  - employment merge additive: never delete scraped rows absent from this payload;
  - photo phase disabled (expired LinkedIn CDN URLs would burn the worker budget);
  - no review_note/network-status side effects beyond never-demote.
- Return the merge outcomes needed for fingerprint-from-results (§5).
- Update the one existing call site (`api/contacts/bulk-import/route.ts`) + tests.

## 4. Publishing flow (admin route + dumb driver script)

- **`careervine/src/lib/bundle-publish.ts`**: `beginPublish` (claims the publish lock via
  conditional UPDATE — errors if another publish is active and unexpired), 
  `publishProspectsChunk` (≤50: validate, canonicalize, hash; insert new / update changed
  / touch `version_last_seen`; re-adds clear `removed_in_version`),
  `publishCompaniesChunk` (`findOrCreateCompany` → `bundle_companies` upsert →
  `findOrCreateLocation` + `ensureCompanyLocation`), `finalizePublish` (soft-remove
  unseen, counts, bump version or skip if zero changes, clear lock, enqueue fan-out),
  `abortPublish` (clear lock).
- **`careervine/src/app/api/admin/bundles/publish/route.ts`**: raw POST, timing-safe
  `Authorization: Bearer ${BUNDLE_ADMIN_TOKEN}` check, Zod discriminated union on `mode`
  ('begin'|'prospects'|'companies'|'finalize'|'abort'), service client, `maxDuration=60`.
- **`careervine/scripts/publish-bundle.mjs`**: converts Apify output →
  `BundleProspectPayloadV1`, chunks, POSTs begin → chunks → finalize. First bundle:
  `research/ib-banks-and-offices.md/.xlsx` content.

## 5. Sync core — `careervine/src/lib/bundle-sync.ts`

- **Claim first**: every driver atomically claims the subscription
  (`UPDATE bundle_subscriptions SET sync_claimed_until = now() + interval '2 min'
  WHERE id = ? AND (sync_claimed_until IS NULL OR sync_claimed_until < now())`); no claim
  → skip. Claim renewed per chunk, cleared on completion.
- `applyBundleDelta(client, userId, subscription, bundle, { cursor, pinnedVersion })`:
  1. Pin `pinnedVersion` on the first call; thread through cursor loops.
  2. Fetch delta chunk (≤50) under the committed-version bound.
  3. **Fingerprint pre-check**: batch-load `bundle_contact_state` + current field
     snapshots for matched contacts; where `apply_started_at` marks a prior interrupted
     apply, refresh the baseline WITHOUT promoting drift; otherwise drift vs
     `applied_fingerprint` → set sticky `user_touched=true`. Set `apply_started_at`.
  4. `importPeopleChunk` with `mergePolicy:'bundle'` via `payloadToImportInput`.
  5. Upsert linkage rows (`created_by_bundle` from created-vs-updated,
     `bundle_prospect_id` + canonical `linkedin_url`; suppressed results get no linkage)
     and write the new `applied_fingerprint` computed **from the pre-snapshot + merge
     results** (no DB re-read — closes the TOCTOU window), clear `apply_started_at`.
  6. Removal phase (cursor-chunked, `removed_in_version > synced_version AND <=
     pinnedVersion`), correlated via linkage `bundle_prospect_id`: delete the contact
     ONLY IF `created_by_bundle` AND not touched AND **no other active subscription of
     this user links the contact** (indexed sibling check); else delete only the linkage.
     Never tombstone here.
  7. Both phases done → `synced_version = pinnedVersion`, `last_synced_at = now()`,
     clear claim.
- **Fingerprint** — `computeContactFingerprint(state)`, pure, explicit allowlist:
  user-editable contact fields (first/last name, headline, notes, persona,
  `network_status`, `stage_override`), manual-source child rows
  (`contact_companies`/`contact_emails` where source='manual'), tag set, and counts of
  interactions/meetings/follow-ups. EXCLUDES importer-written fields (`photo_url`,
  `last_scraped_at`, provenance, scraped-source child rows).
- `isContactTouched` = sticky `user_touched` OR hard signals (any `interactions`,
  `meeting_contacts`, `follow_up_action_items`, `email_follow_ups`) OR current
  fingerprint ≠ stored. Pure over `fetchTouchSignals` batch loads.
- **Tombstone-on-delete (S5)**: the in-app contact-deletion path writes a
  `suppressed_imports` tombstone when the contact has any bundle linkage (or non-null
  `import_source`), so deleted contacts stay deleted under auto-sync;
  `importPeopleChunk` already skips suppressed URLs. Unsubscribe-with-removal does NOT
  tombstone (would break resubscribe; sync never runs for inactive subscriptions).
- All service-client writes scoped by the subscription's `user_id` (defense in depth).

## 6. Delivery: subscribe, updates, worker

- **`POST /api/bundles/subscribe`** (user client): upsert subscription (`active`, reset
  `synced_version=0` on resubscribe). No import work.
- **`POST /api/bundles/apply`** (user client, `maxDuration=60`): `{ bundleId, cursor?,
  pinnedVersion? }` → claim → `applyBundleDelta` → `{ done, nextCursor, pinnedVersion,
  applied, removed }`. Drives initial subscribe with determinate progress
  (`applied / prospect_count`); closed-tab mid-apply self-heals via fan-out/cron.
- **`POST /api/queue/bundle-sync`** (QStash-signed worker, service client,
  `maxDuration=60`): `{ subscriptionIds: [...], cursor state }`; verifies signature,
  processes subscriptions serially under a ~45s budget, re-enqueues itself with remaining
  work. `finalizePublish` enqueues stale subscribers **in batches** (e.g., 10/message)
  with QStash flow-control parallelism, so a publish to 50 subscribers doesn't stampede
  Supabase. Check the Upstash plan's daily message quota (existing 15-min schedule
  already consumes ~96/day).
- **Daily QStash schedule → `POST /api/cron/sync-bundles`**: safety net — enqueue worker
  messages for active subscriptions with `synced_version < version` (missed fan-outs,
  interrupted applies), bounded batch. Ops: Dawson creates schedule + confirms quota in
  the Upstash console; no repo config change.
- **Opportunistic self-sync**: Settings section mount → if stale, run the
  `/api/bundles/apply` loop silently (claim column makes this race-safe); toast only on
  failure.

## 7. Unsubscribe

`POST /api/bundles/unsubscribe` — `{ bundleId, keepAll, cursor? }` (cursor-looped), lib
`unsubscribeFromBundle`:
- Always: `status='unsubscribed'` (row kept → clean resubscribe).
- `keepAll=true`: delete all linkage rows for the subscription.
- `keepAll=false`: for `created_by_bundle=true` linkage rows — untouched (per
  `isContactTouched`) AND no sibling active subscription links the contact → delete the
  contact; else delete only the linkage. Returns `{ removed, kept }`.
- Never writes `suppressed_imports`.

## 8. Settings UI

- `careervine/src/app/settings/page.tsx`: add `{ id: "data", label: "Data subscriptions",
  icon: Database }` + section conditional.
- New `careervine/src/components/settings/data-subscriptions-section.tsx` (modeled on
  `integrations-section.tsx`): card per published bundle (name, description, counts,
  updated date); Subscribe with determinate progress; subscribed state
  "Subscribed · Last synced …" (+ syncing indicator); Unsubscribe dialog (radio: keep all
  / remove untouched; helper: "Contacts you've edited, tagged, contacted, or moved out of
  Prospects are always kept"); empty state. Browse data via browser Supabase client
  (house convention). M3 tokens, `useToast`, no clutter.

## 9. Schemas & tests

- `api-schemas.ts`: `bundleSubscribeSchema`, `bundleApplySchema`,
  `bundleUnsubscribeSchema`, `bundlePublishSchema`, `bundleSyncQueueSchema`.
- Vitest (mock-Supabase pattern), `careervine/src/__tests__/`:
  - `bundle-payload.test.ts` — schema validation, adapter mapping, unknown
    schema-version skip-and-report, Apify→payload fixtures.
  - `bundle-publish.test.ts` — version bookkeeping (new/changed/unchanged/re-added),
    publish-lock claim/reject/abort, finalize removals + counts, zero-change finalize
    skips bump+fan-out, invalid payload rejection.
  - `bundle-sync.test.ts` — pinned-version delta bounds (staged rows never applied),
    `synced_version` = pinned only on completion, claim respected, linkage
    `created_by_bundle` + durable keys, suppressed → no linkage, removal phase incl.
    **sibling-subscription protection**, idempotent re-apply.
  - `bundle-fingerprint.test.ts` (pure) — allowlist stability, bundle-applied changes
    don't trip it, user edits do, sticky never un-sets, interrupted-apply recovery does
    NOT promote drift, hard signals flip touched independently.
  - `bundle-merge-policy.test.ts` — bundle mode never overwrites headline/provenance,
    additive employment, photo phase off; pipeline mode unchanged.
  - `bundle-unsubscribe.test.ts` — keepAll vs remove-untouched, sibling protection, no
    tombstones, resubscribe resets.
  - `bundle-routes.test.ts` — 401s, Zod rejects, timing-safe admin token, QStash
    signature rejection.
  - Tombstone-on-delete test for the contact-deletion path.
  - Update existing bulk-import tests (contact_id, input options, default policy
    unchanged).

## 10. Implementation order (each step: code + tests + `npm run test` in `careervine/` + commit/push)

1. Migration (six tables + RLS incl. WITH CHECK + indexes) + `database.types.ts`.
   (Dawson applies via `supabase db push` locally — never SQL against prod.)
2. Payload contract + adapter + tests.
3. Import-machinery extensions (contact_id, pre-mapped input, **merge policy**) + tests.
4. Publish lib (incl. lock) + admin route + schemas + tests; document `BUNDLE_ADMIN_TOKEN`.
5. `publish-bundle.mjs` driver (Apify → payload conversion).
6. Sync lib (claims, pinned versions, fingerprints, sibling checks) + subscribe/apply
   routes + tombstone-on-delete + tests.
7. Unsubscribe lib + route + tests.
8. QStash worker (batched) + fan-out in `finalizePublish` + cron safety net
   (+ Upstash console setup + quota check note for Dawson).
9. Settings tab + `data-subscriptions-section.tsx` incl. opportunistic self-sync.
10. README product blurb + first-bundle dry run against local Supabase.

## Verification

- Unit: full Vitest suite green (`npm run test` in `careervine/`).
- End-to-end (local Supabase + `npm run dev`):
  1. Publish a small test bundle via `publish-bundle.mjs`; verify shared company rows,
     counts, malformed prospect rejected, second concurrent `begin` rejected by the lock.
  2. Subscribe as a test user; verify prospects as `network_status='prospect'` with
     bundle provenance, progress UI, `synced_version` advances, state rows written.
  3. Edit one imported contact (headline + note), re-publish with one changed / one new /
     one removed-touched / one removed-untouched prospect; sync; verify: the headline
     edit SURVIVES (merge policy), `user_touched` stuck, new appeared, removed-untouched
     deleted, removed-touched orphaned.
  4. **Overlap test**: second bundle sharing a prospect — subscribe to both, verify no
     false touched flags from alternating syncs; unsubscribe-with-removal from one →
     shared contact survives (sibling protection).
  5. Delete a bundle-created contact in-app → tombstone written → next sync does NOT
     resurrect it.
  6. Unsubscribe with "remove untouched" → touched kept, pristine removed, zero
     tombstones; resubscribe → full re-apply works.
  7. Worker route: invalid QStash signature → 401; drive `applyBundleDelta` via lib for
     the fan-out path (prod smoke test after deploy — QStash can't reach localhost).

## Open risks (accepted)

1. **Photo expiry**: bundle mode skips the photo phase; publish-time mirroring to
   R2/storage is the CAR-24 follow-up (payload already carries stable `photo_url`).
2. **QStash quota**: verify Upstash plan daily message limit covers fan-out volume
   (batching keeps it ~5-10 messages per publish per 50 subscribers).
3. **Employment last-writer semantics across bundles**: additive-only bundle merges mean
   stale bundle experience rows persist until the contact is re-scraped by a richer
   source — acceptable; correctness over churn.
4. **`BUNDLE_ADMIN_TOKEN` hygiene**: timing-safe compare, never logged.
