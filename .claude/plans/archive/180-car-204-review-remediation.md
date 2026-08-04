# CAR-204 — Deep-review remediation for the CAR-188 sweep

Ten-agent review of `dcdc053..bddcab0` (live in production). This fixes what it
found. The two systematic risks were clean — no verb downgraded to POST, no
204/empty-body exposure — so everything here is a specific behavioral defect,
not a class of them.

## The pattern worth naming

Three of the worst findings share one shape: **the sweep turned a silently-
ignored refusal into a false failure report.** A refusal that used to pass
unnoticed now shows the user a red error over an operation that actually
succeeded, and the retry it invites does real damage because the underlying
writes are not idempotent. That is worse than the silence it replaced. The
lesson for the fixes below: "check the response" is not the goal; "tell the
user the truth" is. A 429 cooldown and a 409 already-cancelled are both
successes from the user's point of view.

## Order of work

Highest-consequence first, since this is already live.

1. **`handleSnooze`** (`app/page.tsx`) — drop the `dismissSuggestion` gate. The
   save already marked the event `Actioned` and the feed filters on `New`, so
   the dismiss is redundant on that path and gating on it reports failure over
   a complete success. Also fix the comment, which asserts the opposite.
2. **Scheduled-email cancel/retry** — add the `useRef` in-flight guard, and
   treat a 409 as terminal-with-explanation rather than "Please try again".
3. **Calendar Sync 429** — success-with-no-work: still reload, no error banner.
4. **AI-writer context bleed** — clear `meetings` in the catch and reset
   `selectedMeetingIds` when the recipient changes.
5. **Contact page `Promise.all`** — settle the two reads independently so a
   failed schedule read cannot discard a good email read or blank the Timeline.
6. **`loadFailed` wiring** — destructure it in both consumers and render
   `LoadErrorState`. Without this the flag is dead and the outage still reads
   as "no suggestions".
7. **`/api/suggestions/save` ordering** — mark the change event before creating
   the action item, so a throw cannot orphan a committed write.
8. **Confirm-dialog placement** — stop propagation on the dialog root (fixes the
   calendar deselect), hoist the timeline confirm above the remount-keyed
   boundary, and document + test the every-return-path invariant.
9. Smaller introduced items: AbortError guard, `follow-up-modal` raw message,
   template panel gating, `discovery-card` 409 copy, contact-email banner race,
   the two "Unauthorized" copy regressions, key-card add-key block.

## Comments to correct

Six comments the sweep added assert things that are false. Each gets corrected
against what the code actually does, not deleted — the reasoning is why the
next reader trusts or distrusts the line above it:

- the ghost-draft "daily sweep" that does not exist (and the real consequence:
  a re-sendable draft of an already-sent email)
- the ai-followups PATCH called "analytics bookkeeping" when it gates a
  duplicate send
- the autosave `error-tolerated:` rationale applied to the explicit Save button
- `confirm-dialog.tsx`'s `submittingRef` justification, true of none of the 12
- `data-scraping-section.tsx`'s "not available" state that does not exist
- `modal.tsx`'s "no topmost check needed", true for Tab and false for Escape

## Tests

The gaps the review found are the ones worth closing, in priority order:

1. **`jsonBody` verb reaches the wire** — ten production sites depend on the
   second argument and nothing asserts it. Verb correctness was the main risk
   this change set carried; it should not be re-testable only by eye.
2. `use-suggestions-dismiss` — assert `unmatched`/`countOf` in the three tests
   that do not, so "the request failed" cannot be confused with "the test
   stubbed the wrong URL".
3. `saveSuggestion`'s failure path, which a new production branch is gated on.
4. Regression tests for each behavioral fix above.
5. Fix `confirm-dialog.test.tsx`'s settle-once test to actually exercise the
   `pendingRef` guard rather than listener teardown.

## Out of scope

Pre-existing, filed separately: the non-existent `/api/attachments/upload`, the
key-status routes returning 200 on a read error (which defeats fix 9's guard),
`availability-picker`'s stranded spinner, `InteractionsPage` having no consumer,
and the admin surface's missing `withToastOnError`/`LoadErrorState`/tests.

## Verify

`npm run test`, `npm run lint`, `npx tsc --noEmit`, `npm run check:conventions`,
`npm run build`, all cold with no `.next` present (rule 48).
