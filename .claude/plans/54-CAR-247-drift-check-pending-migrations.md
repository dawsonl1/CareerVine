# CAR-247 — Make the production drift tripwire actually work

## What the ticket said, and what turned out to be true

CAR-247 was filed as "the drift check false-positives on pending CHECK constraints and blocks a legitimate push." That is real and is reproduced below. But investigating it surfaced a second, worse defect the ticket did not know about, and the two together invert the original diagnosis.

Measured against live production on 2026-08-07, with the two CAR-242 migration files removed from the local chain so production genuinely carried **two columns and four CHECK constraints the chain does not produce** (unambiguous drift, the exact rule-12 scenario this script exists for):

| CLI | Result |
| --- | --- |
| **2.109.1** (the version pinned since CAR-229) | `{"diff":"","dropStatements":[]}` — "No schema changes found" |
| **2.111.0** | The full `ALTER TABLE ADD COLUMN / ADD CONSTRAINT / COMMENT` set |

**The pin was not protecting correctness. It was suppressing it.** Under 2.109.1 this tripwire passed unconditionally, which is strictly worse than the false positive that opened the ticket: a green light that means nothing.

### Reconciling this with CAR-229

CAR-229 observed 2.110.0 emitting `DROP FUNCTION` for a pending migration and concluded 2.110.0 had "inverted the diff direction," so it pinned to 2.109.1. That reading was wrong on both counts:

- The direction was never inverted. `db diff` reports *statements that turn the local chain into prod*, so a pending CREATE legitimately appears as a DROP. 2.109.1 does it too — CAR-242's pending CHECK constraints, on the pinned version, with the pin working.
- 2.109.1 looked quiet only because CAR-229 happened to test a **function**, one of the object types 2.109.1 cannot see at all. The apparent "correct" behavior and the blindness are the same bug.

## Fix, in two independent parts

**1. Move the pin to 2.111.0.** Restores the ability to see drift at all. Deliberately independent of the 2.109.1 pin `gen-supabase-types.sh` / `ci.yml` use for `gen types`, which exists for byte-identical output and is untouched.

**2. Stage the shadow at the APPLIED chain.** `migration list --linked` names the versions prod has; anything local-only is copied out into a temp `--workdir` whose `supabase/migrations/` contains only applied files. The shadow is then exactly what prod *should* look like, so any reported difference can only be undocumented prod state — regardless of which direction the CLI reports in.

This is what makes the check correct rather than merely re-verified per release. Pinning alone would only relocate the false positive.

**Bonus, free from the ledger comparison:** a migration on prod with **no local file** is now caught explicitly, before any diff. That is rule 12's original incident (a migration lost in a move), and the whole-chain diff could never distinguish it.

## Verified end-to-end against live production

| Scenario | Expected | Result |
| --- | --- | --- |
| A. Prod in sync, nothing pending | clean, exit 0 | clean, exit 0 |
| B. Pending migration adding a column + CHECK + comment | clean (staged out), exit 0 | clean, exit 0 |
| B'. Same state, staging disabled | reproduces the bug | `DROP CONSTRAINT` / `DROP COLUMN` reported as drift |
| C. Prod carries a constraint the applied chain does not produce | detected, exit 1 | detected, exit 1 |

B' is the original CAR-242 failure reproduced exactly; C is the case 2.109.1 was blind to.

## Notes

- `${arr[@]+"${arr[@]}"}`, not `"${arr[@]}"`: under `set -u`, bash 3.2 (macOS default) aborts on expanding an empty array. Caught locally; CI's bash 5 would not have.
- The staged workdir copies **all** of `supabase/`, then swaps in a filtered `migrations/`. Copying only `config.toml` + `.temp` fails: `config.toml` references sibling files (auth email templates) and the CLI refuses a config whose referenced paths are missing.
- The new staging test initially asserted only the log line, which passes even when staging never happens. It now asserts the staged directory contents, and was falsified by probe.
