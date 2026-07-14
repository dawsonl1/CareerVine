# CAR-119 — Fix AI suggestions always showing "Never contacted" (phantom last-touch RPC)

## Problem

AI suggestion cards on the home "Up Next" list always label the contact "Never contacted", even for people with logged interactions (reported: Nathan Privari, who has a "Sent: Car trouble…" interaction and reads as *0 days ago* everywhere else).

**Root cause:** `fetchSuggestionCandidates` (`careervine/src/lib/ai-followup/generate-suggestions.ts:54`) sources last-touch **only** from a Postgres RPC `get_contacts_with_last_touch`, which **does not exist in production** (`PGRST202`; never in any migration or git history). The error is swallowed → every contact gets `days_since_touch: null` → every suggestion → `formatLastContacted(null)` = "Never contacted".

**Collateral:** three rule-based generators gate on `days_since_touch !== null` (FirstTouch, NoInteractionCadence, DecayWarning) and so have never fired in production.

The rest of the app is correct — it reads `interactions` + `meetings` directly via `buildLastTouchMap` (`queries.ts:44`). The suggestion path was the only caller of the phantom RPC.

## Design

Compute last-touch in TS in the suggestion path, mirroring `buildLastTouchMap`, and split the overloaded "days since" value into two distinct meanings:

- **`last_touch` / `days_since_touch`** = most recent real touch (interaction OR meeting); `null` when never contacted. Drives the label (fixes Nathan) and decay logic.
- **`days_since_added`** (new) = days since `contacts.created_at`. What the "first touch"-style generators actually mean by "Added N days ago".

A contact counts as "never contacted" via `last_touch === null` (counts meetings, unlike the old `interaction_count === 0` check).

## Changes (code-only, no migration)

1. **`suggestion-types.ts`** — add `days_since_added: number | null` to `SuggestionContact`.
2. **`generate-suggestions.ts`**
   - `fetchSuggestionCandidates`: drop the `get_contacts_with_last_touch` RPC. Select `created_at` on contacts; query `interactions` (date + count) and `meeting_contacts→meetings` for the user's contacts; build a last-touch map (max of interaction/meeting dates); derive `last_touch`, `days_since_touch`, `days_since_added`, `interaction_count`.
   - `generateNoInteractionCadenceSuggestions`: gate on `last_touch === null` + `days_since_added` (>= cadence); evidence + `daysSinceContact` use the added-days / null-label split.
   - `generateFirstTouchSuggestions`: gate on `last_touch === null` + `days_since_added` (<= 30); same split.
   - Graduation / DecayWarning / LLM: unchanged except they keep reading the now-correct real `days_since_touch`.
3. **`suggestion-scoring.test.ts`** — update fixtures for the new field + the never-contacted gating; add coverage for FirstTouch and the revived NoInteractionCadence path.

## Verification

- `npm run test` (Vitest) from `careervine/` — all pass, including new suggestion coverage.
- `npm run build`.
- Sanity: re-fetch Nathan's suggestion → label reflects the real interaction ("Contacted today" / "1 day ago"), not "Never contacted".

## Out of scope

- Not creating the `get_contacts_with_last_touch` migration (would add a 4th parallel last-touch impl; TS mirror keeps one source of truth).
- No change to the label copy or `formatLastContacted`.
