# 34 · CAR-33 · Worktree → Linear → PR lifecycle automation

Make the full work lifecycle happen **without manually telling each Claude/worktree**: open a worktree off `main`, plan → Linear, implement, PR → In Review, merge → Done, then a guarded "clean up this worktree."

## Guiding architecture

1. **The branch name is the worktree↔issue binding.** Every branch is `dawson/CAR-XX-slug`. Any hook, in any worktree, parses `CAR-XX` from the current branch and knows which Linear issue to touch. This is what removes "tell each Claude."
2. **Linear is durable state; worktrees and conversations are disposable.** Anything that must outlive a deleted conversation — the plan, progress, and the list of manual steps Dawson still owes — is written to Linear, never left in chat.
3. **Hooks trigger deterministically; Claude reasons about content.** Status flips are model-free scripts. Plan text and prose summaries go through Claude+MCP.
4. **Project-scoped, committed.** All of this lives in the repo's `.claude/` (versioned, present in every worktree), NOT a user-level plugin — it is CareerVine/Linear-specific and must not fire in other projects.

## Prerequisite (Dawson, one-time): `LINEAR_API_KEY`

1. Linear → **Settings → Security & access → Personal API keys → New API key** (label it `careervine-hooks`). Copy the `lin_api_...` value.
2. Add to `~/.config/claude/secrets.zsh` (chmod 600, never pasted into chat):
   ```sh
   export LINEAR_API_KEY="lin_api_xxxxxxxx"
   ```
3. **Restart Claude Code** afterward. Hooks run as `bash` subprocesses and inherit the env from the Claude process, not from `~/.zshenv` directly — so the Claude process must be relaunched from a shell that already has the key.
4. Document the key (name + scope only) in the global `CLAUDE.md` Services table.

Linear GraphQL notes for the scripts: endpoint `https://api.linear.app/graphql`; header `Authorization: <key>` (personal keys take the raw key — **no** `Bearer` prefix); resolve `CAR-XX` → issue UUID + teamId via the `issue(id:"CAR-XX")` query; flip state with `issueUpdate(input:{stateId})`; post with `commentCreate`.

## Components

### 1. Shared library — `.claude/hooks/lib/linear.sh`
- `linear_issue_from_branch` — `git rev-parse --abbrev-ref HEAD`, case-insensitive `CAR-[0-9]+`, upcased. Empty → caller exits 0 silently (work on `main`/no ticket is not an error).
- `linear_gql <query> <variables-json>` — curl wrapper; no-op with a stderr note if `LINEAR_API_KEY` unset (degrade gracefully, never block the user's git action).
- `linear_resolve_issue CAR-XX` → `{uuid, teamId, stateName, stateType}`.
- `linear_state_id <teamId> <name>` → workflow-state UUID (resolved by name, so it survives workspace edits).
- `linear_set_state CAR-XX <name>` — flips state; **guards against downgrades** (won't move In Review/Done back to In Progress).
- `linear_upsert_comment CAR-XX <marker> <body>` — find a comment containing an HTML marker (`<!-- marker -->`); `commentUpdate` if present else `commentCreate`. Enables idempotent plan/manual-TODO posts.

### 2. Hook — plan written → post plan + In Progress
- **Event:** `PostToolUse`, matcher `Write`.
- **Script:** `.claude/hooks/on-plan-write.sh`. If `tool_input.file_path` matches `*/.claude/plans/*.md`: derive `CAR-XX`, `linear_upsert_comment CAR-XX plan-sync "$(file contents)"`, then `linear_set_state CAR-XX "In Progress"` (guarded). Emits `additionalContext` confirming the sync so Claude/Dawson can see it happened.
- Idempotent via the `plan-sync` marker — safe across plan edits.

### 3. Hook — `gh pr create` → In Review
- **Event:** `PostToolUse`, matcher `Bash`.
- **Script:** `.claude/hooks/on-pr-create.sh`. If `tool_input.command` contains `gh pr create` **and** `tool_response.stdout` contains a PR URL (confirms success): derive `CAR-XX`, `linear_set_state CAR-XX "In Review"`, and `linear_upsert_comment CAR-XX pr-link "PR: <url>"`.

### 4. Hook — `gh pr merge` → Done
- **Event:** `PostToolUse`, matcher `Bash`.
- **Script:** `.claude/hooks/on-pr-merge.sh`. If `tool_input.command` contains `gh pr merge`: derive `CAR-XX` with a fallback chain (current branch → parse PR arg from command → `gh pr view <arg> --json headRefName`, since `--delete-branch` may already be gone). `linear_set_state CAR-XX "Done"`.

### 5. Skill — `worktree-cleanup` (`.claude/skills/worktree-cleanup/SKILL.md`)
Invoked when Dawson says "clean up this worktree" / "clean up worktree." **Guarded teardown:**
1. Identify current worktree, branch, `CAR-XX`.
2. **Block** unless the PR is `MERGED` (`gh pr view --json state`). Report if not.
3. **Block** on uncommitted or unpushed changes — surface them.
4. Confirm the Linear issue is `Done` (flip it if the merge hook somehow missed).
5. Read the issue's `manual-steps` checklist comment; **surface every unchecked item to Dawson with instructions and do not delete** until he confirms they're handled or waived. This is the "tell me what I still need to do before I abandon this forever" gate.
6. Only when clear: `git worktree remove`, delete local branch, delete remote branch, `git worktree prune`.
7. Report exactly what was deleted + anything still outstanding.

### 6. CLAUDE.md Workflows updates
- Rewrite **Branching & PRs** into a full **Worktree lifecycle** (open off `main`, `CAR-XX-slug` naming for both worktree dir and branch, plan→Linear, PR→In Review, `gh pr merge --merge`, guarded cleanup).
- New rule: **manual steps for Dawson must be recorded to the Linear issue** (upsert the `manual-steps` checklist), because conversations get deleted and Linear is the durable record.
- New rule: **worktree + branch both named `CAR-XX-slug`** so the binding is unambiguous.
- Cross-reference the merge-conflict workflow (merging `main` into the branch pre-merge is where it fires).

### 7. `.claude/settings.json`
Register the three `PostToolUse` hooks (`Write`, `Bash`, `Bash`) via `$CLAUDE_PROJECT_DIR/.claude/hooks/...`. Confirm `.claude/settings.json` is committed (not `.local`) so every worktree inherits it.

## Testing
- Each script accepts a mocked hook JSON on stdin; unit-test branch parsing, marker upsert, downgrade guard, and merge fallback with fixtures — no live API needed for logic.
- Live smoke test on a throwaway `CAR-XX` issue once the key is set: write a dummy plan (→ comment + In Progress), open a PR (→ In Review), merge (→ Done), then run cleanup.
- Confirm hooks stay **silent and non-blocking** when `LINEAR_API_KEY` is absent (must never break a git command).

## Risks / decisions already made
- **Determinism:** `LINEAR_API_KEY` chosen over MCP-nudge so status flips are model-free. (CAR-33)
- **Env propagation:** requires a Claude restart after adding the key (documented above).
- **One primary issue per branch** drives automation; a branch closing multiple issues handles the extras via Claude at merge time (out of the deterministic path).
- **No per-commit progress notes** — too noisy; the three anchor states + the plan post are the audit trail.
- This work (CAR-33) is itself a new multi-file feature domain → per rule 19 it should be built in a `CAR-33` worktree and merged via PR, dogfooding the flow (Linear updates done manually until the hooks exist).
