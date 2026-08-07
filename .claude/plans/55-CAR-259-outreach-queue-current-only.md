# CAR-259 — the outreach walkthrough skips companies nobody works at

## The rule that was wrong

`buildOutreachQueue` admitted a target company on:

```ts
const queue = targets.filter((c) => c.current_count + c.former_count > 0);
```

It adds current and former together, so a company whose entire roster has moved on
still earns its own screen in the company-by-company flow, presented as outreach to do.

Measured on production 2026-08-07 for `dawsonlpitcher@gmail.com`:

| | companies |
| --- | --- |
| Open target companies (targeted, status != closed) | 327 |
| In the walkthrough, someone currently there | 129 |
| **In the walkthrough, everyone has left** | **53** |
| Already skipped, nobody at all | 145 |

53 of 182 queued companies had zero current employees. Qualtrics led with 20 contacts
and not one still there, then Instructure (9), Intuit (8), Overstock.com (7),
FranklinCovey (5).

The underlying `is_current` flags were sanity-checked before trusting them: those rows
carry real end dates (Oct 2019, Dec 2018, Jun 2012), and 9,998 of 10,055 contacts have
a current job on file somewhere. This is not a scraping artifact.

## Change

`current_count > 0`. Former employees stay reachable everywhere else (the company
roster's Former group, contact search, the company page); they just stop generating a
"here is who to email about a job HERE" prompt, because there is no job here.

Both surfaces that describe the skip move with it, since the old wording named only the
bench:

- `/outreach` footer: "only bench people or nobody" to "nobody working there now"
- MCP `list_outreach_queue` summary: "nobody contactable" to "nobody works there now"
- `PeopleSkeleton`'s header comment asserted a former-only company still qualifies.
  Now false, so it is corrected rather than left as a lie; the zero branch stays for the
  genuine stale-count case.

## Tests

`outreach-queue.test.ts`:

- The existing `former-only companies still qualify` test asserted exactly the behavior
  being removed. **Inverted, not deleted**, so the file still states a position on the case.
- The admission test gains an `AllLeft` company and asserts `skippedCount` counts it.
- New: a company with 1 current and 40 former stays queued (the gate is current > 0,
  not a ratio).

Falsified by restoring `current_count + former_count > 0`: 2 tests fail.

## Docs

`public/docs/index.html` "Nothing hides silently" card described the skip as bench-only.
Rewritten to state the real rule and that former employees remain one click away.

## Verification

`npm run test`, `npm run check:conventions`, `npm run test:integration`, `npm run build`.
