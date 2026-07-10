# Agent Instructions

Read this entire file before starting any task.

## Self-Correcting Rules Engine

This file has two parts, both authoritative:

- **`## Workflows`** — the stable, canonical description of how we work on this project (Linear, branching/PRs, merge conflicts, plan files). Read this first; it's the readable summary of process.
- **`## Learned Rules`** — an append-only log of corrections and preferences. Never rewritten, only added to.

**At session start, read the `## Workflows` section AND the entire `## Learned Rules` section before doing anything.** Where a Workflow and a Learned Rule overlap, they're kept consistent; if they ever conflict, the newer statement wins (per rule 6 of "How it works").

### How it works

1. When the user corrects you or you make a mistake, **immediately append a new rule** to the "Learned Rules" section at the bottom of this file.
2. Rules are numbered sequentially and written as clear, imperative instructions.
3. Format: `N. [CATEGORY] Never/Always do X — because Y.`
4. Categories: `[STYLE]`, `[CODE]`, `[ARCH]`, `[TOOL]`, `[PROCESS]`, `[DATA]`, `[UX]`, `[OTHER]`
5. Before starting any task, scan all rules below for relevant constraints.
6. If two rules conflict, the higher-numbered (newer) rule wins.
7. Never delete rules. If a rule becomes obsolete, append a new rule that supersedes it.

### When to add a rule

- User explicitly corrects your output ("no, do it this way")
- User rejects a file, approach, or pattern
- You hit a bug caused by a wrong assumption about this codebase
- User states a preference ("always use X", "never do Y")

### Rule format example

```
15. [STYLE] Never add emojis to commit messages — project convention.

```

---

## Workflows

Canonical, stable process for this project. Unlike Learned Rules (an append-only correction log), this section is edited in place to stay accurate. Rules in the log that codify or supersede a workflow are cross-referenced by number.

### Linear tickets

Project is managed through Linear — team **"Career Vine"**, ticket prefix **`CAR-`**. No work happens off-ticket. (Standing order; see rule 18.)

1. **Before starting any task**, search existing issues (`list_issues`, team "Career Vine"). Reuse a relevant ticket if one exists; otherwise create one in the "Career Vine" team, assigned to Dawson.
2. **Status flips and plan/PR posts are automated** on ticket-named branches — see "Linear automation" under Worktree lifecycle. Don't do the hooks' job by hand; do verify it happened.
3. **You still own the rich updates**: progress comments at meaningful steps (slice landed, tests passing), the `manual-steps` checklist, and everything on `main` or non-ticket branches (there, handle status flips yourself via MCP).

### Worktree lifecycle (branching & PRs)

Feature work happens in **worktrees off `main`**, one Linear issue per worktree, with Linear kept in sync automatically by the hooks in `.claude/hooks/` (registered in `.claude/settings.json`, powered by `$LINEAR_API_KEY`; see rules 22–23). The lifecycle:

1. **Open** — `git worktree add .claude/worktrees/CAR-XX-slug -b dawson/CAR-XX-slug main`. Worktree dir and branch are **both named after the ticket** — the branch name is what binds every automatic Linear update to the right issue. If no issue exists yet, create one first.
2. **Plan** — write `.claude/plans/NN-CAR-XX-slug.md`. *(Hook: plan is posted to the issue + issue flips to In Progress.)*
3. **Implement** — build, test, fix. Commit/push to the feature branch freely.
4. **PR** — sync from `main` first (merge it **into** the branch), confirm tests pass (rule 4), then `gh pr create` with `(CAR-XX)` in the title (established convention, e.g. `Add BYO Deepgram API key for transcription (CAR-30)`) and a body covering what/why and how it was verified. *(Hook: issue flips to In Review + PR link recorded.)* Opening the PR is the end of the agent's autonomous path — stop here and wait.
5. **Merge** — **only on Dawson's explicit go-ahead, per PR. Rule 14's auto-push authority covers direct commits, NOT merging PRs — never self-merge.** Then `gh pr merge --merge` (merge commit; never rebase; no `--delete-branch` — the cleanup skill owns branch deletion). **Merging deploys production** via Vercel: if the PR contains migrations, make sure `supabase db push` is on the issue's `manual-steps` checklist before merging. *(Hook: issue flips to Done.)*
6. **Clean up** — when Dawson says "clean up this worktree", run the **`worktree-cleanup` skill** (`.claude/skills/worktree-cleanup/`). It gates deletion on: PR merged, tree clean, issue Done, and **all manual steps surfaced** — then removes the worktree and both branches.

**Risk-based exception (rule 19):** small, single-file, no-schema, no-new-domain changes may commit directly to `main` (rule 14) without a worktree.

**Never** rebase or force-push `main` or any shared/already-pushed branch. Keep branches current by merging `main` in, so conflicts surface early (where the merge-conflict tooling engages).

**Manual steps are Linear's, not the conversation's:** anything Dawson must do by hand (env vars, `supabase db push`, secrets, redeploys) gets upserted to the issue as a `<!-- manual-steps -->` checklist the moment it's identified — conversations get deleted; Linear survives (rule 23).

**Linear automation — how to work with it:**

- **Hooks own** (only on branches containing `CAR-XX`): plan post + In Progress on plan write; In Review + PR link on `gh pr create`; Done on `gh pr merge`. **Don't duplicate these** — no manual state flips or plan-posting at those moments.
- **Agents own**: creating/choosing the issue, progress comments at meaningful steps, the `manual-steps` checklist, and all Linear updates when the automation can't bind (work on `main`, branch without `CAR-XX`).
- **Comment markers** — issue comments are upserted, keyed by an HTML marker on the first line: `<!-- plan-sync -->` (plan), `<!-- pr-link -->` (PR URL), `<!-- manual-steps -->` (Dawson's checklist), `<!-- progress -->` (status summary). Reuse these markers (via MCP or `.claude/hooks/lib/linear.sh`'s `linear_upsert_comment`) instead of posting duplicate comments.
- **Hooks fail silent by design** (missing `$LINEAR_API_KEY`, unnamed branch, API hiccup) so they never block git. So **verify, don't assume**: after a plan write / PR create / PR merge, check the issue state and repair via MCP if a flip was missed. State changes only move forward (Backlog→Todo→In Progress→In Review→Done); hooks never downgrade, and neither should you without Dawson asking.

### Merge conflicts → `merge-conflict-tool` plugin

On **any** git `CONFLICT` (merge, rebase, or cherry-pick), the **`merge-conflict-tool`** skill is the required resolution process (see rule 20). Do **not** hand-resolve, do **not** `git checkout --ours/--theirs` on a content conflict, and do **not** delete conflict markers manually outside that workflow.

**Setup (one-time, interactive — cannot be done from a non-interactive session):**

```
/plugin marketplace add dawsonl1/merge-conflict-tool
/plugin install merge-conflict-tool@dawson-plugins
```

Once installed, its hooks auto-invoke on any conflict. **If you hit a conflict and the skill isn't installed in the current environment**, load and follow it manually from `~/Projects/claude-plugins/merge-conflict-tool/plugins/merge-conflict-tool/skills/merge-conflict-tool/SKILL.md`.

**CareerVine calibration for the skill:**

- **Verification commands:** `npm run test` and `npm run build`, both run from `careervine/`; plus the Supabase migration consistency check whenever migrations are touched.
- **Generated files — never hand-merge, regenerate instead:** `careervine/**/database.types.ts` (regenerate via `supabase gen types`) and the lockfile.
- **Risky surfaces (extra care / halt-and-ask):** Supabase migrations (see rules 10–12), MCP OAuth/bearer auth, bundle billing, `vercel.json` / deploy config, and secrets.
- Visual verification uses the Playwright MCP (installed) — required for any frontend change in the merge result.

### Plan files

- **Location:** repo-root `.claude/plans/` (this supersedes the stale path in rule 6).
- **Naming:** `NN-CAR-XX-slug.md` — a two-digit sequential prefix (highest existing number + 1) plus the Linear ticket, e.g. `31-car-18-add-companies-without-contacts.md` (extends rule 9; see rule 21). One plan file per ticket; never reuse a number.
- Write a plan before starting any non-trivial feature.

### Testing, deploy & QA (pointers)

- Run `npm run test` (Vitest) from `careervine/` and ensure coverage for new/changed code before committing (rules 3, 4).
- Don't browser-verify every UI change — reserve previews for high-risk work (rule 13).
- Push to `main` auto-deploys; env-var changes require a redeploy, empty commit being the established pattern (rule 16). Migrations: dry-run then `supabase db push`; never ad-hoc SQL (rules 10, 15).

---

## Learned Rules

<!-- New rules are appended below this line. Do not edit above this section. -->

1. [PROCESS] Always rephrase user-provided rules into precise, unambiguous language optimized for LLM instruction-following before appending them — because the user's phrasing may be conversational, and rules are most effective when written as clear, direct imperatives with explicit scope and rationale.

2. [PROCESS] Commit and push to remote frequently (after each meaningful change or logical unit of work) — because the user is working via SSH through VS Code and cannot run the dev server on this machine. They pull and test locally on a separate machine, so they need changes pushed promptly to iterate.
   > ⚠️ SUPERSEDED by rule 15 (the SSH-era premise no longer holds — Claude runs directly on the Mac). The "commit/push frequently" habit still applies; the "can't run the dev server here / separate machine" reasoning does not.

3. [CODE] When adding new functionality or modifying existing code, always ensure adequate test coverage exists for the changes and remove or update any stale tests that no longer reflect current behavior — because outdated tests give false confidence and missing tests let regressions slip through.

4. [PROCESS] After completing a change and writing/updating tests, always run the test suite (`npm run test` from the `careervine/` directory, which runs Vitest) and verify all tests pass before committing — because pushing broken tests defeats the purpose of having them and wastes the user's time when they pull to test locally.

5. [UX] Prioritize user experience above all else. Every UI decision must favor clean, intuitive design that serves real functionality and utility — never add visual clutter, unnecessary complexity, or decorative elements that don't help the user accomplish their goals. The product exists to meaningfully improve users' lives, so every interaction should feel effortless and purposeful.

6. [PROCESS] Always write implementation plans to `/home/braxtong/Dawson/CareerVine/.claude/plans/` as a markdown file before starting non-trivial features — because the user wants plans persisted and reviewable on disk, not just in conversation context.
   > ⚠️ CORRECTED by rule 21 / Workflows → Plan files. That absolute path is a stale SSH-era machine location; the real location is **repo-root `.claude/plans/`**. The "write a plan before non-trivial features" intent stands.

7. [PROCESS] After completing a user-facing feature, update the project README to reflect the new capability from a product perspective — describe what the feature does for the user and why it matters, not implementation details. The README should read like a product page that sells the app's value, not a technical changelog.

8. [PROCESS] Always run `git pull` before pushing — because the user frequently pushes empty commits from their local machine to retrigger Vercel deployments (hobby plan limitation), which causes the remote to diverge from this machine's local history. A pre-push pull prevents rejected pushes.

9. [PROCESS] Always number plan files in `.claude/plans/` with a two-digit sequential prefix (e.g., `19-feature-name.md`). Check the highest existing number and increment by one — because the user navigates plans by number, not alphabetically.

10. [DATA] Never run SQL directly against the production Supabase database — because ad-hoc queries bypass migration tracking and can cause schema drift. All schema changes must go through migration files only.

11. [PROCESS] Database migrations are applied to production by the user on their local machine via `git pull`, then `supabase db push` — because the user manages Supabase CLI auth and deployment locally. This machine should only create migration files and commit/push them.
    > ⚠️ SUPERSEDED by rule 15 — Claude now runs on the Mac with authenticated `supabase`/`vercel` CLIs and may apply migrations itself (dry-run first) when the user asks it to handle deployment end-to-end.

12. [DATA] Never assume a schema/types mismatch means the types file is wrong — check `git log --all -- "*.sql"` for deleted migrations first. Migrations originally lived at `careervine/supabase/migrations/` and moved to root `supabase/migrations/`; `20250217_add_location_to_contact_companies.sql` was deleted in that move (commit `9c718fe`) without being re-created, so `contact_companies.location` existed in production untracked until re-added in `20260707000000_company_pages_and_scrape_import.sql`. Production may contain schema from other lost migrations.

13. [PROCESS] Do not verify every UI change with browser previews and screenshots by default — the user reviews changes themselves, and repeated preview/screenshot cycles slow the iteration loop. Use the preview browser only for high-risk changes (layout restructuring, breakpoint logic), when the user explicitly asks for verification, or when debugging requires observing runtime behavior.

14. [PROCESS] When a task includes code or migration changes, automatically commit and push completed, validated work to `main` without asking for additional confirmation — because the user explicitly prefers an automatic commit/push workflow instead of repeated approval prompts.
15. [PROCESS] Claude Code now runs directly on the user's Mac with authenticated `supabase` and `vercel` CLIs (supersedes the SSH-era assumptions behind rules 2 and 11): when the user explicitly asks Claude to handle deployment end-to-end, Claude may verify/apply migrations (`supabase db push`, dry-run first) and trigger/monitor Vercel deployments itself — because the user granted this on 2026-07-09 ("do everything for me") and the local environment has the required auth.

16. [PROCESS] Vercel Git auto-deployments on `main` are re-enabled as of 2026-07-09 (the `vercel.json` that disabled them was deleted): every push to `main` deploys production automatically, and environment-variable changes take effect only on the next deployment — so after changing Vercel env vars, trigger a redeploy (empty commit is the established pattern) before relying on them.

17. [CODE] Never detect the success of a conditional Supabase UPDATE via `.select()` on the same query when the update modifies a column that the query's filters test (CAS/claim patterns like `update({lock: x}).is("lock", null).select()`) — PostgREST re-applies the request filters to the RETURNING representation, so a successful update returns empty rows and reads as a failure. Use `.update(payload, { count: "exact" })` and check the count instead. Found live on the first bundle publish (2026-07-09); the same trap silently zeroed finalizePublish's removal count.

18. [PROCESS] Every task must have a Linear issue (team "Career Vine", prefix `CAR-`): create or reuse one at the start, set it In Progress and assign Dawson, update it at each meaningful step, and mark it Done when complete — because Dawson runs this project through Linear and wants live traceability, not just a final state. Standing order for all work, not a per-request instruction. See Workflows → Linear tickets.

19. [PROCESS] Choose the integration path by risk (see Workflows → Branching & PRs): small, single-file, no-schema, no-new-domain changes commit directly to `main` (rule 14); new feature domains, DB migrations, and multi-file/cross-cutting changes go on a `dawson/CAR-XX-slug` branch and merge via PR. Update a feature branch by merging `main` **into** it — never rebase or force-push `main` or any shared/already-pushed branch, because `main` is a live Vercel deploy target. Sync from `main` before opening a PR so conflicts surface early. Delete branches after they merge.

20. [PROCESS] On any git `CONFLICT` (merge/rebase/cherry-pick), the `merge-conflict-tool` plugin/skill is the required resolution process — never hand-resolve, never `git checkout --ours/--theirs` on a content conflict, never delete markers outside it. Install once via `/plugin marketplace add dawsonl1/merge-conflict-tool` + `/plugin install merge-conflict-tool@dawson-plugins` (interactive only); until then, load its `SKILL.md` from `~/Projects/claude-plugins/merge-conflict-tool` and follow it manually. See Workflows → Merge conflicts for the CareerVine calibration (verification commands, generated files, risky surfaces).

21. [PROCESS] Plan files live in repo-root `.claude/plans/` and are named `NN-CAR-XX-slug.md` — a two-digit sequential prefix (highest existing number + 1) plus the Linear ticket, one file per ticket, never reusing a number. Supersedes rule 6's stale `/home/braxtong/...` path and extends rule 9's numbering to embed the ticket. See Workflows → Plan files.

22. [PROCESS] Name feature worktrees and branches after their Linear ticket — worktree dir `CAR-XX-slug`, branch `dawson/CAR-XX-slug` — because the `CAR-XX` in the branch name is what the lifecycle hooks (`.claude/hooks/`) parse to sync the right Linear issue automatically (plan→In Progress, PR create→In Review, PR merge→Done). A branch without a ticket reference gets no automatic Linear sync. See Workflows → Worktree lifecycle. (CAR-33)

23. [PROCESS] The moment a manual step for Dawson is identified (add an env var, run `supabase db push`, set a secret, redeploy, configure an external dashboard), record it on the Linear issue as a `<!-- manual-steps -->` checklist comment (upsert, don't duplicate) — because conversations and worktrees are disposable and get deleted; Linear is the durable record. The `worktree-cleanup` skill blocks teardown on unchecked items. Never let a manual step exist only in chat. (CAR-33)

24. [PROCESS] Dawson intentionally pastes secret values into chat for Claude to handle — store them in `~/.config/claude/secrets.zsh`, wire them up, and move on. Do not treat pasted secrets as compromised, do not recommend rotation, do not add security caveats about it. (Preference set 2026-07-09; also reflected in global CLAUDE.md Secret handling.)
