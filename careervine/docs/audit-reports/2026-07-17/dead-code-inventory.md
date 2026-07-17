# Dead-code / unused-export inventory (Task 3)

**Date:** 2026-07-17 · **Ticket:** CAR-161 · **Scope:** `careervine/` app package · **Mode:** read-only advisory punch-list (nothing deleted)

## Summary

`knip` was run against `careervine/` with **no project config**, so it uses defaults and
**over-reports** — Next.js route files, config, generated types, dynamic imports, and
manually-invoked ops scripts all show up as "unused." Every raw finding below was
re-verified with `grep` across `src/` and `scripts/` (whole-word, with within-file
occurrence counts) to separate genuinely-dead code from knip false positives.

- **20 exports are genuinely dead and safe to delete now** (bucket A1), all in **non-hot**
  files. The biggest clusters: 5 unused color/label maps in `src/lib/health-helpers.ts`,
  7 unused `*Row` types in `src/lib/types.ts`, and the OpenAI/Deepgram client factories
  `getOpenAIClient` / `createDeepgramRunner`.
- A further **~30 symbols are "over-exported"** (bucket A2): used internally within their
  own file but never imported elsewhere, so the `export` keyword is unnecessary. Safe to
  un-export, but the code itself is live — do **not** delete it.
- A handful of **redundant re-exports / deprecated aliases** (bucket A3) can be trimmed.
- Everything touching a **hot file**, generated file, route, ops script, or a symbol where
  knip's judgment is unreliable is in the **DEFER** bucket — do not act from this report.

**This report is a punch-list for a later cleanup ticket. Do not delete anything based on it
without a final per-symbol confirmation** (especially the client factories and the shared
`types.ts` barrel). knip ran without a config; results are advisory.

---

## Method

Commands run (from `careervine/`):

```
npx knip --no-progress                    # primary run (default config)
```

`npx` fetched knip transiently (it is not a project dependency, and there is **no
`knip.json`/`knip` key in package.json**, so defaults applied). The `--include
files,exports,types` variant was not needed — the default run was already compact
(139 lines). Every candidate was then verified with:

```
grep -rIlw <symbol> src scripts      # which files reference it at all
grep -cw   <symbol> <defining-file>  # within-file occurrences (1 = defined only = fully dead)
```

### Raw knip category counts

| Category | Count |
|---|---|
| Unused files | 10 |
| Unused devDependencies | 1 |
| Unlisted dependencies | 4 |
| Unused exports | 71 |
| Unused exported types | 44 |
| Duplicate exports | 3 |

The two dependency rows (`Unused devDependencies`, `Unlisted dependencies`) are
dependency-hygiene, not dead code — see the DEFER section; they belong to the Task 2
dependency report.

---

## (A) SAFE TO REMOVE NOW

All items below are in **non-hot** files and were confirmed with grep. Split by confidence
tier.

### A1 — Fully dead (defined once, referenced nowhere; delete entirely) — 20 items

These have a within-file occurrence count of **1** (the definition/export line only) and
**zero** references anywhere else in `src/` or `scripts/`.

**Values (11):**

| Symbol | File:line | Notes |
|---|---|---|
| `healthBgColors` | `src/lib/health-helpers.ts:28` | Unused health-color map |
| `healthStyles` | `src/lib/health-helpers.ts:36` | Unused health-style map |
| `healthRingColors` | `src/lib/health-helpers.ts:44` | Unused health-color map |
| `healthLabels` | `src/lib/health-helpers.ts:54` | Unused health-label map |
| `CRITICAL_OVERDUE_DAYS` | `src/lib/health-helpers.ts:52` | Unused constant |
| `OPEN_FOLLOW_UP_MESSAGE_STATUSES` | `src/lib/constants.ts:36` | Unused status list |
| `MEETING_TYPE_OPTIONS` | `src/lib/constants.ts:290` | `@deprecated` alias of `CONVERSATION_TYPE_OPTIONS`; also a knip "duplicate export" |
| `applicationsOpenValueIsEmpty` | `src/lib/applications-open-value.ts:117` | Unused helper |
| `createDeepgramRunner` | `src/lib/deepgram.ts:322` | Unused factory (`isDeepgramAuthError`/`isDeepgramQuotaError` in the same file are internally used — see A2) |
| `getOpenAIClient` | `src/lib/openai.ts:103` | Unused OpenAI client factory. **Confirm before deleting** — verify the app reaches OpenAI through a different accessor; surprising for a client factory to be fully dead. |
| `patchPipelineState` | `src/lib/pipeline-state.ts:300` | Unused; note `pipeline-state.ts` is NOT the hot `pipeline-queries.ts` |

**Exported types (9):**

| Type | File:line | Notes |
|---|---|---|
| `UserRow` | `src/lib/types.ts:18` | `queries.ts`/`follow-up-nudges` references are a JSDoc comment and a local `interface UserRow`, not imports |
| `CompanyRow` | `src/lib/types.ts:24` | Unused Row alias |
| `CompanyLocationRow` | `src/lib/types.ts:25` | Unused Row alias |
| `TargetCompanyRow` | `src/lib/types.ts:26` | Unused Row alias |
| `TargetCompanyNoteRow` | `src/lib/types.ts:27` | Unused Row alias |
| `LocationRow` | `src/lib/types.ts:28` | Unused Row alias |
| `FollowUpReminder` | `src/lib/types.ts:126` | Unused type |
| `LatestRequest` | `src/hooks/use-latest-request.ts:51` | Unused type |
| `PipelineMainTab` | `src/lib/pipeline-state.ts:82` | Unused type |

> Caveat on `src/lib/types.ts`: it is a shared type barrel. knip only scanned `careervine/`,
> so "unused" means unused *within the app*. The `careervine-mcp/` and `chrome-extension/`
> packages have separate tsconfigs and are unlikely to import app-internal types, but a
> 10-second cross-package grep before deletion is cheap insurance.

### A2 — Over-exported (used internally, never imported elsewhere; un-export only, keep the code) — ~30 items

knip flags these as "unused exports" because nothing imports them, but each is **referenced
inside its own file** (occurrence count ≥ 2). The safe action is to **drop the `export`
keyword**, not to delete the symbol. Lower value; batch these only if the cleanup ticket
wants strict encapsulation.

**Values:** `getApifyToken` (`apify/client.ts:87`), `monthStartIso` (`apify/spend.ts:17`),
`PUBLISH_LOCK_EXPIRY_MS` (`bundle-publish.ts:34`), `FUNCTION_MAX_MS` / `SYNC_STEP_RESERVE_MS`
/ `getQstashClient` (`bundle-queue.ts:34/39/58`), `RESOLVE_CHUNK_SIZE` (`bundle-resolve.ts:50`),
`SYNC_CHUNK_SIZE` / `fetchTouchSignals` / `findSiblingLinkedContacts` (`bundle-sync.ts:54/221/312`),
`ALLOWED_CONTACT_PHOTO_TYPES` (`contact-photo.ts:3`), `isDeepgramAuthError` /
`isDeepgramQuotaError` (`deepgram.ts:184/190`), `usStateCode` (`location-tab-label.ts:56`),
`scrubOpenAIError` (`openai.ts:350`), `PHOTO_THUMB_QUALITY` (`photo-thumb.ts:14`),
`photoPublicBaseUrl` (`photo-urls.ts:15`), `createPipelineEntityId` (`pipeline-state.ts:90`,
base of the id-alias cluster), `CURRENT_MARKER` (`profile-helpers.ts:7`), `deletePhotoObject`
(`r2.ts:87`), `SWEPT_BUCKETS` (`storage-sweep.ts:34`), `fetchSuggestionCandidates` /
`generateLlmSuggestions` (`ai-followup/generate-suggestions.ts:46/370`),
`CardHeader` / `CardFooter` (`components/ui/card.tsx:40/76`, shadcn-style primitives — commonly
kept for API completeness even if unused).

**Types:** `RelationshipsOnTrackData` (`home/networking-stats.tsx`), `ScheduleEventAttendee` /
`LogConversationEvent` (`home/today-schedule.tsx`), `ActionItemType` (`home/unified-action-list.tsx`),
`SelectOption` (`ui/select.tsx`), `AdminUserBase` (`admin-users.ts`), `ResolveCandidate`
(`apify/resolver.ts`), `TrackerState` / `ImportHooks` (`bulk-import.ts`), `ApplyStep`
(`bundle-apply-client.ts`), `BundleSyncJob` (`bundle-queue.ts`), `ResolvedExperience` /
`ResolvedEducation` (`bundle-resolve.ts`), `ContactSnapshot` / `TouchSignalSet` (`bundle-sync.ts`),
`AnniversaryEmployment` (`change-events/anniversary.ts`), `DeepgramRunner` (`deepgram.ts`),
`LocationGranularity` (`location-normalizer.ts`), `SharedAccessState` (`openai.ts`),
`CurrentCollisionStrategy` (`scrape-merge.ts`), `SweptBucket` / `BucketSweepResult`
(`storage-sweep.ts`), `TranscriptFormat` (`transcript-parser.ts`), `TranscriptSegmentRow`
(`types.ts`), `EmailSentDetail` (`ui-events.ts`).

### A3 — Redundant duplicate exports / re-export aliases (delete the alias/re-export line) — safe, low value

- **`export default AiUnavailableNotice;`** — `src/components/ai/ai-unavailable-notice.tsx:127`.
  The **named** `AiUnavailableNotice` is imported in 8 places; the default alias is never used.
  Drop the default line. (knip "duplicate export".)
- **Redundant re-exports of `r2KeyFromPublicUrl` and `isBundlePhotoUrl`** in `src/lib/r2.ts:32`.
  Both are defined in and imported directly from `@/lib/photo-urls`; the `r2.ts` re-export of
  those two names is never consumed (the sibling re-exports `r2PublicUrl` / `isUserPhotoUrl`
  **are** used, so only trim the two dead names).
- **`MEETING_TYPE_OPTIONS`** deprecated alias — already listed in A1 (it's both fully dead
  and a duplicate export).

---

## (B) DEFER — do not act from this report

### B1 — Hot files (report-only; Waves 4–6 delete much of this anyway)

knip flagged these, but they are on the CAR-161 hot list. Left untouched by design:

- **`src/lib/queries.ts`** (hot): `activateContacts`, `updateContactEmail`, `deleteContactEmail`,
  `updateContactPhone`, `deleteContactPhone`, `deleteTag`, `getContactsDueForFollowUp`,
  `getEmailsForContact`, `getFollowUpsForThread`, `getActiveFollowUps`, `updateSegmentContact`,
  `getRecentUncontactedContacts`.
- **`src/lib/company-queries.ts`** (hot): `PRODUCT_PERSONAS`, `isByuSchoolName`, `addCompanyOffice`,
  `updateTargetCompanyTargeted`, `removeTargetCompany`, `updateTargetCompany`, `addTargetCompanyNote`,
  `deleteTargetCompanyNote`.
- **`src/lib/pipeline-queries.ts`** (hot): `APPLICATION_FILES_BUCKET`, `PipelineScope`.
- **`src/lib/gmail.ts`** (hot): `checkForReplyInThread`.
- **`src/lib/calendar.ts`** (hot): `getCalendarClient`.
- **`src/mcp/**`** (hot): `getEmailsForContact` (`mcp/lib/db.ts:855`), `ok` / `fail`
  (`mcp/lib/tool-utils.ts:14/18`), `dossierSchema` / `addNoteSchema` / `tagContactSchema`
  (`mcp/tools/contacts.ts:32/68/73`), `ActionItemRow` interface (`mcp/lib/db.ts:522`).
- **`src/components/contacts/contact-info-header.tsx`** (hot) — knip reports it as an
  **entirely unused file** (grep confirms **no importer in `src/`**). It is on the hot list, so
  this is report-only. This is the single most interesting DEFER item: if it is truly orphaned,
  the owning wave/ticket should confirm and remove the whole file rather than this cleanup ticket.

### B2 — Generated file (never hand-edit)

`src/lib/database.types.ts` — knip flags `Constants`, `Tables`, `TablesUpdate`, `Enums`,
`CompositeTypes`. This file is **generated by `supabase gen types`** (see CLAUDE.md /
merge-conflict calibration). Regenerate, never edit. Ignore.

### B3 — Ops scripts (manually-invoked CLI entrypoints, not dead code)

knip's "Unused files (10)" are standalone operational scripts run by hand, not imported
modules. Default knip entry patterns don't treat them as entrypoints, so they false-positive.
Keep all:

`scripts/configure-auth-emails.mjs`, `scripts/diagnose-email-sync.mjs`, `scripts/grant-admin.mjs`,
`scripts/lib/r2-photos.mjs` (imported by `publish-bundle.mjs` and `migrate-photos-to-r2.mjs`),
`scripts/migrate-photos-to-r2.mjs`, `scripts/posthog-backfill-connection-state.mjs`,
`scripts/publish-bundle.mjs` (**live ops tooling — referenced in CLAUDE.md rule 29**),
`scripts/sweep-storage-orphans.mjs`, `scripts/verify-admin-rls.mjs`.

(The 10th "unused file" was `contact-info-header.tsx`, handled in B1.)

### B4 — Barrel re-exports (design choice, not clearly dead)

- **`src/lib/capabilities/index.ts`** — `capabilitiesFor` and type `EntitlementFlags`
  re-exports. The underlying symbols are live (used via `./map`, `./resolve`, tests); the
  barrel re-exports simply aren't consumed. Whether to keep the barrel is a design call, not
  a dead-code deletion — defer to the module owner.
- **`src/lib/bundle-sync.ts:47`** — `export { computeContactFingerprint, normalizeTagNames,
  type ContactFingerprintInput }` re-export. Consumers import these from `./bundle-fingerprint`
  directly; the bundle-sync re-export is unused but is a legitimate barrel. Defer.

### B5 — knip-unreliable / not dead

- **`type Priority`** (`src/lib/priority-helpers.ts:1`) — knip flags it, and grep is noisy
  (the word "Priority" appears as UI label text and inside identifiers like `newPriority`,
  and the imported symbols are the different `PRIORITY_*` constants). knip's AST analysis says
  the `Priority` **type** is unimported; that is probably correct, but the generic name makes
  this lower-confidence. Confirm manually before touching; not in the SAFE bucket.
- **`ContactRow` / `MeetingRow`** (`src/lib/types.ts:19/20`) — flagged, but each is used
  **internally** to build `Contact` / `Meeting` (and other files define their own local
  `ContactRow`/`MeetingRow`). Over-exported at most (un-export), never delete. Kept out of A1
  to avoid confusion with the truly-dead Row aliases.

### B6 — Dependency findings (belong to the Task 2 dependency report)

Not dead code; surfaced by knip and cross-referenced here:

- **Unused devDependency:** `@testing-library/jest-dom` — `src/__tests__/setup.ts` is an empty
  stub and does **not** import it, so knip may be right that it's currently unused. Confirm in
  the dependency report before removing (it's commonly wired into a jsdom setup file that this
  app's node-environment tests don't use).
- **Unlisted dependencies:** `fast-glob` (used by several `src/__tests__/*` files but not in
  `package.json`), `@ext/content/identify-sections` (a `@ext` path-alias into the extension
  package, resolved by vitest config — not a real npm package). These are test-infra config
  gaps, not dead code.

---

## Appendix — confidence notes

- Every A1 item was verified two ways: **zero** whole-word references outside its defining file
  (`grep -rIlw`), **and** a within-file occurrence count of exactly 1 (definition only).
- A2 items differ only in the within-file count (≥ 2 = used internally), which is why they are
  un-export candidates rather than deletions.
- Because knip ran **without a project config**, treat this entire inventory as **advisory**.
  A future cleanup ticket should re-run knip *after* adding a minimal `knip.json` (declaring
  `scripts/**/*.mjs`, route files, and generated `database.types.ts` appropriately) to shrink
  the false-positive surface, then delete A1, un-export A2, and trim A3.
