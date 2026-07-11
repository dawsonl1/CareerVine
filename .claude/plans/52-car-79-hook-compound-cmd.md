# CAR-79 — Linear hooks: resolve ticket ref on compound `cd && gh` commands

## Problem

On 2026-07-11 two PR creations ran as `cd <worktree> && gh pr create ...` from a session
whose cwd (and hook cwd) was the main checkout on `main`. The In Review flip never fired
and nothing surfaced, violating the CAR-39 exit-2 contract.

Reproduced: the settings matcher (`Bash`) and the `grep 'gh pr create'` both match compound
commands fine. The actual hole is ref resolution — `linear_issue_ref` runs
`git rev-parse --abbrev-ref HEAD` in the **hook process cwd** (session dir, on `main`), not
in the worktree the command `cd`'d into. Empty ref → the "not a ticket branch" silent
`exit 0` path swallows a genuine ticket PR.

`on-pr-merge.sh` shares the cwd hole and adds one: its no-ref fallback greps the **first
number anywhere in the command** as the PR number, so `cd .claude/worktrees/CAR-78-x &&
gh pr merge 46` would resolve PR **78** (from the path), flipping the wrong ticket.

## Fix

`lib/linear.sh`:
- `_ln_cmd_cd_dir "$cmd"` — extract the target of a leading `cd <dir> &&`/`;` in a compound
  command (handles simple and quoted paths; empty otherwise).
- `linear_issue_ref [dir]` — optional dir arg, runs `git -C "$dir"` when given.

`on-pr-create.sh` — resolve ref through a fallback chain, most authoritative first:
1. branch of the `cd` target dir from the command (the worktree actually operated on)
2. branch of the hook cwd (existing behavior, still right for in-worktree sessions)
3. `gh pr view <url> --json headRefName` (URL is already extracted; works from any cwd)
4. `_ln_parse_ref` on the command text (title convention `(CAR-XX)`, worktree path)

Still `exit 0` when all four miss — a PR from a genuinely non-ticket branch is a valid
silent skip. Any resolved ref keeps the existing exit-2-on-failed-sync behavior.

`on-pr-merge.sh`:
- same dir-aware ref resolution (1, 2)
- fix the PR-number fallback to parse only the args **after** `gh pr merge` (number or PR
  URL), run `gh pr view` from the cd dir when one was parsed, then (4) command-text parse.

## Tests

Extend `.claude/hooks/test/run.sh` (pure-logic, no API):
- `_ln_cmd_cd_dir`: plain `cd x && ...`, quoted path, no-cd command, `cd` not at start.
- `linear_issue_ref` with dir arg against throwaway git repos (ticket branch vs main).
- merge PR-number parsing: `cd .../CAR-78-x && gh pr merge 46` → `46`, not `78`.
- end-to-end silent-skip regression: on-pr-create with the CAR-78-style payload from a
  `main` cwd must now resolve CAR-78 (assert via a stubbed resolver, no network).

## Verify

- `bash .claude/hooks/test/run.sh` all green.
- Re-run the original repro payload — hook must now attempt the sync (and exit 2 loudly if
  Linear is unreachable) instead of exiting 0 silently.
- This PR itself is the live test for step 2 (in-worktree create on a CAR branch).
