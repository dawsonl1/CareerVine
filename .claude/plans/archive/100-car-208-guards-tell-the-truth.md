# CAR-208 — Make the guards tell the truth

Six fixes from the Wave 2 audit, all of the same shape: a guard or a doc that
disagreed with the code it describes. A guard that passes without binding is
worse than no guard, because it is read as proof.

## 1. Double-submit detector (check `i`)

Three blind spots removed from `careervine/scripts/check-conventions.mjs`:

- **Handler-name filter.** It required `/^(handle|on)[A-Z]/`, so it inspected a
  mutation called `handleAdd` and ignored an identical one called `addContact`.
  58 functions.
- **Inline JSX handlers.** `onClick={async () => { await apiSend(…) }}` has no
  declaration to hang a name on, so the whole *form* was invisible. 17 sites,
  keyed by prop name (the ratchet's multiset accounting handles repeats).
- **Import shapes.** Only named imports resolved a seam, so a default or
  namespace import of a `@/lib` module bound a seam the scan could not see —
  and an empty seam set skips the file outright. Type-only imports now
  excluded, since a type is never the mutating call.

Dropping the name filter also surfaced two **false** positives it had been
hiding by accident: server files were never excluded here, so an async RSC and
a Route Handler outside `src/app/api` both appeared. Neither can double-submit;
the check now skips server files as `(g)` and `(h)` already did.

Baseline 54 → **129**. Deliberately over-inclusive — see the docblock.

**Live bug fixed:** `careervine/src/components/admin/contacts-section.tsx`.
`addContact` was an unguarded `apiSend` POST gated only by React state, so
double-clicking Add created two contact rows. `injectBundle` beside it has the
same shape and applies a bundle twice. Both now claim a synchronous `useRef`.

### A near-miss worth recording

`fetch` is absent from `READ_VERB`, which looks like a plain oversight — the
list already has `get`, `load` and `read`. Adding it silently un-flagged
`handleUnsubscribe`, the most destructive handler on the list, because its
paged POST loop goes through a helper called `fetchStepWithRetry`. Reverted,
and the header now records why extending that list is the dangerous direction.

## 2. `useLatestRequest` detector (check `j`)

`gatesStaleCommit` had two independent defects:

- **One polarity.** `let cancelled = false` passed; `let mounted = true` was
  reported as a violation — the worst outcome for a ratchet, since clearing the
  entry means rewriting correct code.
- **Existence, not gating.** The three facts were collected over the whole body
  and intersected by name, so any unrelated boolean triple cleared *every*
  commit in the effect.

Now: both polarities, and the flag must stand between the response and **every**
commit — an early return positioned after the await, or a condition enclosing
the commit. Membership is unchanged at seven (neither shape was present here),
and the header says so, because "the baseline did not move" reads like "nothing
changed".

## 3. Delete overlay check (`k`)

Two guards enforced the dialog rule with near-anagram escape hatches —
`overlay-not-a-dialog:` in the script, `non-dialog-overlay:` in
`dialog-adoption.test.ts` — and neither honoured the other's. Check `k` is
deleted: its baseline was empty and the vitest guard covers a broader file set
in a stricter form. Hatch vocabulary drops from eight tokens to seven.

`diffCountRatchet` loses its script consumer; kept (with its tests) and labelled
as such rather than silently dead.

## 4. Three false claims in `CONVENTIONS.md`

All verified against the code, all false:

- "Two specs mint their own identity" — **three** do.
- "`settings-keys` re-seeds the Gmail connection" — `86ca7c2` deleted that
  `afterEach`; `revokeAccess` also nulls two contact columns and deletes every
  `email_message` and `calendar_event`, so re-seeding restored one of four
  things. The spec owns its tenant now.
- "`resolve.ts` fails open to premium on a null flag" — `premium_enabled` is
  `NOT NULL DEFAULT true`, so that branch cannot fire.
  `e2e/helpers/tenant.ts` already documented the truth the doc contradicted.

Two new pins in `conventions-doc.test.ts`, both falsified: the own-identity spec
count (computed from `mintSessionUrl` call sites, matched against
whitespace-normalized prose so a reflow cannot break it), and a check that the
retired hatch token never reappears in source.

## 5. `src/mcp` into the coverage gate

16 modules, ~3,300 lines, measured at **47.07% / 39.86%** entirely outside
`coverage.include`, with `src/mcp/tools` at 4.25%. Its only CI job is
`tsc --noEmit`.

Folding it in costs the globals ~2 points (69.18/61.86/66.41/72.25 → 67.35/
60.14/64.35/70.45, both from the same run). Global floors re-baselined
66/59/63/69 → **65/58/62/68**. `src/mcp` gets its own per-area budget so it
cannot hide behind `src/lib`.

`src/hooks` had drifted the other way — documented at 24.94%, actually 39.30%,
so its budget authorized 69 statements of free debt. Re-measured too.

## 6. Document what the detectors do not catch

File header now separates the decidable checks from the heuristics, and `(i)`
and `(j)` each carry a "what this cannot see" list. A green run means "nothing
matched the shapes we know how to look for".

## Verification

- `npm run check:conventions` exits 0; `check:ui-events` exits 0
- Every fixed detector falsified: 8 targeted patches, each reverting one fix,
  each turning its test red
- `npm run test` — 2,736 passed / 272 files
- `npm run test:coverage` passes the re-baselined floors; the `src/mcp` budget
  proven live by tightening it to an impossible value
- `npx tsc --noEmit` cold (`.next` moved aside), `npx eslint .`, `next build`
