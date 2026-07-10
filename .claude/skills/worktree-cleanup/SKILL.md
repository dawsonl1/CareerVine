---
name: worktree-cleanup
description: Guarded teardown of a finished feature worktree. Use when Dawson says "clean up this worktree", "clean up the worktree", "tear this down", or similar after a PR has merged. Verifies the PR is merged, the tree is clean, the Linear issue is Done, and surfaces any manual steps Dawson still owes BEFORE deleting the worktree and its branches. This is the last gate before conversations get archived forever — never skip the manual-steps check.
---

# worktree-cleanup

Tear down a finished worktree **only after proving nothing will be lost**. Conversations and worktrees are disposable; anything still owed must be surfaced now or moved to Linear (the durable record) before deletion.

## Order of operations — all gates before any deletion

### 1. Identify

```bash
WT=$(git rev-parse --show-toplevel)          # current worktree path
BR=$(git rev-parse --abbrev-ref HEAD)        # its branch
REF=$(echo "$BR" | grep -oiE 'car-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]')
git worktree list
```

If run from the main checkout instead of the worktree, ask which worktree to clean and operate on that path; never guess.

### 2. Gate: PR merged

```bash
gh pr view "$BR" --json state,mergedAt,url -q '{state,mergedAt,url}'
```

- `MERGED` → proceed.
- `OPEN`/`DRAFT` → **stop.** Report the PR state and URL; cleanup happens after merge.
- No PR found → **stop and ask.** Either the work never got a PR (direct-to-main per rule 19 — confirm the commits are on `main` with `git log origin/main --oneline | grep`-style verification) or something is wrong.

### 3. Gate: nothing unsaved

```bash
git -C "$WT" status --porcelain        # must be empty
git -C "$WT" log --oneline @{u}.. 2>/dev/null   # unpushed commits — must be empty
git -C "$WT" stash list                # surface any stashes
```

Any dirt, unpushed commits, or stashes → **stop**, show them, and ask whether to preserve (commit/push/apply) or discard. Never discard silently.

### 4. Gate: Linear closed out

Check the issue state (MCP `get_issue` on `$REF`, or the hooks' lib). If not **Done**, flip it — the `on-pr-merge` hook should have done this; note the miss.

### 5. Gate: manual steps owed — THE critical gate

Read the issue's comments for a `<!-- manual-steps -->` checklist and scan the conversation/plan for anything Dawson must genuinely do by hand (OAuth grants, DNS, external dashboards, values only he can obtain). Migrations and Vercel env vars are never Dawson's (CLAUDE.md rules 27–28) — if the merged PR carried an unapplied migration, apply it now (`supabase db push --dry-run`, review, `supabase db push`); if it needs an env var whose value exists in `secrets.zsh` or chat, set it via `vercel env add` and redeploy.

- Unchecked items → **present them as explicit instructions and stop.** Do not delete. Wait for "done" or "waive".
- Nothing owed → say so explicitly ("no manual steps outstanding") so the all-clear is on record.

New manual steps discovered here must be upserted to the Linear issue (marker `manual-steps`) before proceeding — the conversation is about to be deleted; Linear is what survives.

### 6. Delete (only now)

```bash
cd "$(git worktree list | head -1 | awk '{print $1}')"   # leave the doomed worktree first
git worktree remove "$WT"            # refuses if dirty — do NOT jump to --force; re-run gate 3
git branch -d "$BR"                  # -d not -D: refuses if unmerged — that's the point
git push origin --delete "$BR"
git worktree prune
```

If `git branch -d` refuses, the merge gate lied — stop and re-verify rather than forcing.

### 7. Report

State exactly what was deleted (worktree path, local branch, remote branch), the issue's final state, and repeat any waived manual steps one last time. This is the final message before the conversation is archived — make it self-sufficient.

## Never

- Never `--force` a worktree removal or `-D` a branch to get past a failed gate.
- Never delete when the PR isn't merged, without explicit confirmation.
- Never let a manual step live only in the conversation — Linear or it doesn't exist.
