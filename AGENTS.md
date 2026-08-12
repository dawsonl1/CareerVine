# Agent Instructions

Read both sections below before starting any task.

## Self-Correcting Rules Engine

Two authoritative parts:

- **`## Workflows`** — canonical process, edited in place to stay current. **On any overlap or conflict with a Learned Rule, Workflows wins** (rules absorbed there are archived).
- **`## Learned Rules`** — a small, curated set of standing behavioral corrections. Between conflicting rules, the higher number (newer) wins.

**This file is read in full before every task.** Its size is a tax on every task, so the engine is built to shed weight, not just accumulate it.

### 1. Intake test — apply BEFORE appending anything

A correction earns a Learned Rule only if it changes behavior on a **future, unseen** task. Ask:

> Would this fire on a task I have not seen yet, in a file I have not opened?

- **Yes** → write the rule.
- **No — it describes a trap in one specific file, API, or command** → **it is not a rule.** Put the guard where the trap lives: a header comment at the call site, a test, or a check in `check-conventions.mjs`. A rule naming one file is documentation in the wrong place: it costs context on every unrelated task and is invisible at the moment it actually matters.

Wrong home, right home: "library X breaks on Vercel" → a test. "this table's CHECK omits Y" → a comment in the data layer. "the CLI writes status to stderr" → fix the script, comment why. The incident narrative belongs in the Linear ticket, never here.

### 2. Writing a rule

`N. [CATEGORY] Never/Always do X — because Y.` Categories: `[STYLE] [CODE] [ARCH] [TOOL] [PROCESS] [DATA] [UX] [OTHER]`.

Rephrase into a precise imperative with explicit scope. State the **behavior, not the incident** — one clause of provenance is the maximum. If a rule needs a paragraph of story to justify itself, it failed the intake test.

### 3. Retiring a rule

**Never delete or renumber.** A rule leaves the live list exactly one of four ways, moving **verbatim** to `.Codex/rules-archive.md` with a note naming which:

1. **Superseded** — a newer rule replaces it.
2. **Absorbed** — folded into `## Workflows`.
3. **Merged** — combined into another live rule (name it).
4. **Localized** — its lesson now lives as a guard at the code site. **Name the file and line.** Never localize a rule without first verifying the guard actually exists; if it does not, write the guard in the same pass or keep the rule live.

The numbering gap stays; the audit trail survives.

### 4. Budget — the forcing function

The live list is capped at **25 rules**. At the cap, a consolidation pass runs *before* the next append: merge overlapping rules, and retire anything that fails today's intake test. Growth past the cap is not allowed; the cap is what keeps this file from becoming the changelog it was turning into.

---

## Workflows

Canonical, stable process for this project — edited in place to stay accurate, and authoritative over older Learned Rules. Rules fully absorbed here live in `.Codex/rules-archive.md`.

> **Code conventions live in [`careervine/CONVENTIONS.md`](careervine/CONVENTIONS.md)**, not here. This file governs *process* (tickets, branches, PRs, deploys); that one covers *how to write code that fits* (API route shape, the data layer and its `db()`/`must()` seam, capability gating, cron wrappers, client-state rules, auth exceptions, test harness). It is a pointer index into authoritative code headers, so read the header it names rather than trusting a summary. Read it before your first non-trivial code change.

### Linear tickets

Project is managed through Linear — team **"Career Vine"**, ticket prefix **`CAR-`**. All **product work** happens on a ticket (app, extension, MCP server, migrations, shipped tooling); meta-work on agent process files (AGENTS.md, memory, config) needs none (rule 25).

1. **Before starting any task**, search existing issues (`list_issues`, team "Career Vine"). Reuse a relevant ticket if one exists; otherwise create one in the "Career Vine" team, assigned to Dawson.
2. **Status flips and plan/PR posts are automated** on ticket-named branches — see "Linear automation" under Worktree lifecycle. Don't do the hooks' job by hand; do verify it happened.
3. **You still own the rich updates**: progress comments at meaningful steps (slice landed, tests passing), the `manual-steps` checklist, and everything on `main` or non-ticket branches (there, handle status flips yourself via MCP).

### Worktree lifecycle (branching & PRs)

Feature work happens in **worktrees off `main`**, one Linear issue per worktree, with Linear kept in sync automatically by the hooks in `.Codex/hooks/` (registered in `.Codex/settings.json`, powered by `$LINEAR_API_KEY`). The lifecycle:

1. **Open** — `git worktree add .Codex/worktrees/CAR-XX-slug -b dawson/CAR-XX-slug main`. Worktree dir and branch are **both named after the ticket** — the branch name is what binds every automatic Linear update to the right issue. If no issue exists yet, create one first.
2. **Plan** — write `.Codex/plans/NN-CAR-XX-slug.md`. *(Hook: plan is posted to the issue + issue flips to In Progress.)*
3. **Implement** — build, test, fix. Commit/push to the feature branch freely.
4. **PR** — sync from `main` first (merge it **into** the branch), confirm tests pass (rule 3), then `gh pr create` with `(CAR-XX)` in the title (established convention, e.g. `Add BYO Deepgram API key for transcription (CAR-30)`) and a body covering what/why and how it was verified. *(Hook: issue flips to In Review + PR link recorded.)* Opening the PR is the end of the agent's autonomous path — stop here and wait.
5. **Merge** — **only on Dawson's explicit go-ahead, per PR. Rule 14's auto-push authority covers direct commits, NOT merging PRs — never self-merge.** Then `gh pr merge --merge` (merge commit; never rebase; no `--delete-branch` — the cleanup skill owns branch deletion). **Merging deploys production** via Vercel: if the PR contains migrations, Codex applies them itself immediately after merging — `supabase db push --dry-run`, review the plan, then `supabase db push` (rule 27; Dawson never runs supabase commands). *(Hook: issue flips to Done.)*
6. **Clean up** — when Dawson says "clean up this worktree", run the **`worktree-cleanup` skill** (`.Codex/skills/worktree-cleanup/`). It gates deletion on: PR merged, tree clean, issue Done, and **all manual steps surfaced** — then removes the worktree and both branches.

**Risk-based exception:** small, single-file, no-schema, no-new-domain changes may commit directly to `main` (rule 14) without a worktree.

> **A direct push is the only path where `main` can go red, so it carries an extra obligation.** `main` has branch protection requiring the six checks, but `enforce_admins` is **false** — the owner is deliberately exempt, and pushes made with Dawson's token bypass the gate, printing `Bypassed rule violations for refs/heads/main`. That message is expected on this path, not a warning to escalate. CI itself has no path filters (`push: branches: [main]`), so all six jobs still **run** on a direct push; they simply report afterwards instead of blocking. Therefore: **after any direct push to `main`, verify the run on that exact SHA** (`gh run list --commit <sha>`, then confirm the six jobs by name per rule 45) before treating the work as done. On the PR path the gate does this for you; here nothing does. If the push is genuinely urgent and CI is slow, say so rather than assuming green.

**Never** rebase or force-push `main` or any shared/already-pushed branch. Keep branches current by merging `main` in, so conflicts surface early (where the merge-conflict tooling engages).

**Manual steps are Linear's, not the conversation's:** anything Dawson must genuinely do by hand (OAuth grants, external dashboards, values only he can obtain) gets upserted to the issue as a `<!-- manual-steps -->` checklist the moment it's identified — conversations get deleted; Linear survives. Migrations and Vercel env vars are never on this list — Codex handles both (rule 27).

**Linear automation — how to work with it:**

- **Hooks own** (only on branches containing `CAR-XX`): plan post + In Progress on plan write; In Review + PR link on `gh pr create`; Done on `gh pr merge`. **Don't duplicate these** — no manual state flips or plan-posting at those moments.
- **Agents own**: creating/choosing the issue, progress comments at meaningful steps, the `manual-steps` checklist, and all Linear updates when the automation can't bind (work on `main`, branch without `CAR-XX`).
- **Comment markers** — issue comments are upserted, keyed by an HTML marker on the first line: `<!-- plan-sync -->` (plan), `<!-- pr-link -->` (PR URL), `<!-- manual-steps -->` (Dawson's checklist), `<!-- progress -->` (status summary). Reuse these markers (via MCP or `.Codex/hooks/lib/linear.sh`'s `linear_upsert_comment`) instead of posting duplicate comments.
- **Hooks fail silent by design** (missing `$LINEAR_API_KEY`, unnamed branch, API hiccup) so they never block git. So **verify, don't assume**: after a plan write / PR create / PR merge, check the issue state and repair via MCP if a flip was missed. State changes only move forward (Backlog→Todo→In Progress→In Review→Done); hooks never downgrade, and neither should you without Dawson asking.

### Merge conflicts → `merge-conflict-tool` plugin

On **any** git `CONFLICT` (merge, rebase, or cherry-pick), the **`merge-conflict-tool`** skill is the required resolution process. Do **not** hand-resolve, do **not** `git checkout --ours/--theirs` on a content conflict, and do **not** delete conflict markers manually outside that workflow.

**Setup (one-time, interactive — cannot be done from a non-interactive session):**

```
/plugin marketplace add dawsonl1/merge-conflict-tool
/plugin install merge-conflict-tool@dawson-plugins
```

Once installed, its hooks auto-invoke on any conflict. **If you hit a conflict and the skill isn't installed in the current environment**, load and follow it manually from `~/Projects/Codex-plugins/merge-conflict-tool/plugins/merge-conflict-tool/skills/merge-conflict-tool/SKILL.md`.

**CareerVine calibration for the skill:**

- **Verification commands:** `npm run test` and `npm run build`, both run from `careervine/`; plus the Supabase migration consistency check whenever migrations are touched.
- **Generated files — never hand-merge, regenerate instead:** `careervine/**/database.types.ts` (regenerate via `supabase gen types`) and the lockfile.
- **Risky surfaces (extra care / halt-and-ask):** Supabase migrations (see rules 10 + 32; `scripts/supabase-prod-drift-check.sh` blocks a push when production carries untracked schema), MCP OAuth/bearer auth, bundle billing, `vercel.json` / deploy config, and secrets.
- Visual verification uses the Playwright MCP (installed) — required for any frontend change in the merge result.

### Plan files

- **Location:** repo-root `.Codex/plans/`.
- **Naming:** the **Linear ticket is the unique key** — `CAR-XX-slug`. One plan file per ticket. A two-digit `NN-` prefix may lead the name (e.g. `31-car-18-add-companies-without-contacts.md`); it is an optional, approximate ordering hint, **not** an identifier.
- **Never compute the prefix as "highest existing number + 1".** Parallel worktrees race on it, so duplicate prefixes are already common and harmless. Nothing reads the prefix — `_ln_parse_ref` in `.Codex/hooks/lib/linear.sh` extracts `CAR-XX` from the filename and ignores everything else — so a collision costs nothing and a "correct" number is not worth a round trip. Pick any number at or above the current maximum, or omit it. **Do not renumber existing files.**
- **Superseded plans live in `.Codex/plans/archive/`.** Only active work stays at the top level. The hook's glob (`*/.Codex/plans/*.md`) still matches the archive, and it only ever fires on the file being written, so moving a plan there is inert.
- A plan with no ticket (historical or reference material parked here) just uses a descriptive name. The hook skips a ticket-less plan whose first line is marked HISTORICAL or SUPERSEDED; any **other** ticket-less plan written or edited on a ticket branch binds to that branch's issue via the fallback and will **overwrite its plan-sync comment** — so park archive material with the banner, and author real plans with the ticket in the filename.
- Write a plan before starting any non-trivial feature.

### Docs & copy drift

Public text is a commitment that rots silently. Update it in the **same branch/PR** as the behavior change, checked proactively without being asked:

- **Docs page** — `careervine/public/docs/index.html` (served at docs.careervine.app): whenever a change alters the user-visible behavior of any surface it describes. It deploys with the app, so behavior merged without a copy update ships wrong documentation.
- **Privacy policy** — `careervine/src/app/privacy/page.tsx`: whenever what CareerVine persists about users or third parties changes (a new stored field, table, cache, log, or third-party processor, or a change to deletion/retention behavior). Google and the Chrome Web Store both audit it against actual behavior.
- **Cadence copy** — a change to `careervine/scripts/qstash-schedules.mjs` requires re-checking everything that quotes a cadence. `cron-schedules-registry.test.ts` pins the cron expressions, the follow-up and scheduled-email cadence prose in `careervine/README.md` and the docs page (subject-anchored), the docs page's follow-ups feature-card tag, and the two interval cron routes' header comments — it fails on a miss in any of those. Copy quoting the **daily/weekly** schedules ("daily safety-net sweep", "once a week") is not pinned — that is yours to re-check.
- **Conventions doc** — `careervine/CONVENTIONS.md`: when a convention changes or an authoritative header moves. It is a pointer index, not a map; keep it pointing at code rather than restating it. A test asserts every path it cites still exists.
- **No em dashes** in user-facing copy (rule 35).

The failure mode this guards against is real and recent: CAR-157 found the same "every 15 minutes" claim wrong in four files for a job that runs every 10, and an `ARCHITECTURE.md` so stale it still said "No automated tests exist" against ~2,100 passing tests. The falsification pass over the replacement doc's own first draft caught 8 false and 4 misleading claims before it shipped — write the claim, then try to break it.

### Testing, deploy & QA (pointers)

- Run `npm run test` (Vitest) from `careervine/` and ensure coverage for new/changed code before committing (rule 3).
- Don't browser-verify every UI change — reserve previews for high-risk work (rule 13).
- **The six required checks on `main` are `web`, `mcp`, `extension`, `types-drift`, `integration`, `e2e`.** That is the job list rule 45 tells you to verify by name, rather than inferring green from the absence of failures.
- Push to `main` auto-deploys; env-var changes require a redeploy, empty commit being the established pattern. Migrations: Codex applies them itself on landing — dry-run then `supabase db push` (rule 27); never ad-hoc SQL (rule 10).
- **Waiting for a deploy to go live:** `node scripts/wait-for-deploy.mjs [--sha <commit>] [--timeout <secs>]`, run **from the repo root**, not from `careervine/` like the test commands above it (defaults to origin/main's head, 15s polls). Exit 0 = READY + alias assigned (live on the domain), 1 = build failed, 2 = timeout. This is the ONLY sanctioned deploy watch — never grep `vercel ls` (the CLI writes its status table to stderr, so the usual `| grep Ready` matches nothing and hangs forever). Note: the Vercel project's Root Directory is `careervine/`, so commits touching nothing under it (docs, scripts, AGENTS.md, migrations-only) never create a deployment at all — the script detects this and exits 0 immediately.

---

## Learned Rules

<!-- New rules are appended below this line. Do not edit above this section. -->

> **Archived** → `.Codex/rules-archive.md`, verbatim, with the reason each left: rules 2, 6, 9, 11, 18–23, 34, 46 (superseded/absorbed), and 4, 12, 15, 16, 17, 28, 29, 30, 33, 36, 39, 40, 43, 44, 47, 48, 49, 51 (merged into a live rule, or localized to a verified code-site guard). Numbering is never reused — the next new rule takes the number after the highest below (53).
>
> 22 live, 30 archived, 52 accounted for. **Before localizing a rule, open the guard and confirm it exists** — three of these were nearly archived on the strength of "the convention isn't written up in CONVENTIONS.md," which measures documentation, not enforcement. Two turned out to be guarded already; the third had no guard until one was written for it.

1. [PROCESS] Always rephrase user-provided rules into precise, unambiguous imperatives with explicit scope and rationale before appending them — because conversational phrasing is ambiguous, and a rule is only as good as its worst reading.

3. [CODE] Ensure adequate test coverage for every change, update or remove stale tests that no longer reflect behavior, and run the suite (`npm run test` from `careervine/`) before committing — because untested changes and outdated tests both give false confidence, and pushing a red suite wastes Dawson's time when he pulls.

5. [UX] Prioritize user experience above all else. Every UI decision must favor clean, intuitive design that serves real functionality — never add visual clutter, unnecessary complexity, or decorative elements that don't help the user accomplish their goals.

7. [PROCESS] After completing a user-facing feature, update the README from a product perspective — what the feature does for the user and why it matters, not implementation details. It should read like a product page, not a technical changelog.

8. [PROCESS] Always `git pull` before pushing — because Dawson pushes empty commits from his own machine to retrigger Vercel deploys, so the remote diverges from this machine's history and an un-pulled push is rejected.

10. [DATA] Never run SQL directly against the production Supabase database — all schema changes go through migration files only, because ad-hoc queries bypass migration tracking and cause schema drift.

13. [PROCESS] Do not verify every UI change with browser previews and screenshots — Dawson reviews changes himself and the cycle slows iteration. Reserve previews for high-risk work (layout restructuring, breakpoint logic), explicit requests, or debugging that requires observing runtime behavior.

14. [PROCESS] Never re-ask for authority already granted. Commit and push completed, validated work automatically, and once a plan is approved build it end to end — no per-phase checkpoints, no "ready for the next one?". Report when the work is done, when genuinely blocked on something only Dawson can supply, or when a finding changes the plan's shape. Scope: this covers direct commits on the risk-based path, NOT merging PRs (never self-merge).

24. [PROCESS] Dawson intentionally pastes secret values into chat — store them in `~/.config/Codex/secrets.zsh`, wire them up, and move on. Never treat them as compromised, recommend rotation, or add security caveats about it.

25. [PROCESS] Linear tickets are required only for product work — the app, extension, MCP server, migrations, and repo tooling that ships. Meta-work on agent process files (AGENTS.md, memory, agent config) needs no ticket, because Linear tracks the product, not Codex's own process maintenance.

26. [PROCESS] Never ask Dawson to do something Codex can do itself — exhaust the shell, authenticated CLIs (`gh`, `supabase`, `vercel`, `Codex`), the keys in `secrets.zsh`, MCP connectors, and browser control first. Interactive-looking tasks usually have non-interactive equivalents. Hand him only what genuinely requires him (a decision, an OAuth prompt, a value only he can obtain), ask for the minimal input rather than a procedure, and say why it can't be done for him.

27. [PROCESS] Codex owns the deploy surface as standing authority — Dawson never runs `supabase` or `vercel` commands, and neither ever appears on his manual-steps checklist. Migrations: `supabase db push --dry-run`, review, then `supabase db push` the moment migration-carrying work lands. Vercel env: `vercel env add/rm/ls` from `careervine/`, then trigger the redeploy env changes require (empty commit is the pattern). Rule 10 stands: migration files only, never ad-hoc SQL.

31. [PROCESS] Brainstorm fully BEFORE a decision, commit fully AFTER. While brainstorming, stay in it until Dawson explicitly signs off — walk every meaningful option with trade-offs, including choices you would otherwise make unilaterally, and cover the whole problem space; a couple of multiple-choice questions is one step, not the brainstorm. Once he has chosen, treat it as final: surface a genuinely new consideration at most ONCE, and if he reaffirms, implement without further comparison or re-recommendation.

32. [DATA] Never treat `supabase db push --dry-run` as validation that a migration's SQL is correct — it only lists what would be pushed and never executes SQL, so it cannot catch references to dropped tables or columns. The sanctioned pre-apply validation is executing the migration against production inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` — zero drift, and it proves the migration applies against real schema and data.

35. [STYLE] Never use em dashes (—) in user-facing copy: rendered UI text, marketing and landing copy, the docs page, emails, any product surface a user reads. Use a comma, colon, parentheses, or separate sentences. Code, comments, commit messages, Linear/PR text, and these agent process files are unaffected.

37. [PROCESS] Never raise an alarm about repository or `main` integrity from a proxy signal like a line count or a failed offset-read — verify by direct comparison first (`git rev-parse <ref>:<path>` blob hashes, `git diff`, `git show`). Generalizes: never surface a scary claim you have not actually checked.

38. [PROCESS] Always pull remote `main` onto local `main` after merging a PR, and whenever returning to `main`, so the primary checkout stays current with `origin/main`.

41. [PROCESS] When Dawson commits to a scope, execute ALL of it as committed work — never present subsets as "optional", "skippable", or "defer knowingly", and never build effort-based off-ramps into a plan he already chose. A defect you have already diagnosed is work, not a question: fix it in the same pass rather than reporting it back as a judgment call. Filing a Linear ticket for a finding is DEFERRAL, not resolution — "filed rather than fixed here" is the exact phrasing to stop writing. Unrelated surface, pre-existing, and low severity are reasons the fix is *wider*, not *later*. File a follow-up ticket only for work genuinely blocked on a decision only Dawson can make or on an external dependency, and say which.

42. [DATA] When a PR's code reads or writes columns that its own migration adds, apply the migration to production BEFORE merging (expand-then-deploy), inverting rule 27's default order — because merge auto-deploys within minutes and the new code hard-fails against the old schema in the window, and supabase-js surfaces the resulting 42703 as `{data: null}` WITHOUT throwing, so null-guards misread it as "absent". Additive nullable columns are always safe to apply early.

45. [PROCESS] Never report CI as green from the absence of failing checks — verify the expected JOB LIST is present and passing via `gh run list` on the head SHA plus `gh run view <id> --json jobs`. A conflicted PR produces no Actions run at all, so the checks UI shows only the non-Actions integrations passing and reads as all-clear. `gh pr checks` alone cannot report a job that was never created. A `mergeStateStatus` of DIRTY/BLOCKED means investigate, never retry-and-hope.

50. [TOOL] Never `git checkout -- <file>` to undo a temporary edit on uncommitted work — it restores from the INDEX, discarding every uncommitted change in the file, not just your probe. Commit first (a WIP commit is free and amendable) or copy the file to the scratchpad and restore with `cp`. Applies to any probe-and-revert workflow: falsification passes, bisecting, testing a hypothesis by breaking something.

52. [PROCESS] Never conclude a test is vacuous (or a guard missing) from a falsification probe that came back clean until you have confirmed the probe actually mutated the intended code — print the `git diff` and read it before trusting a green run. A file-wide `sed`/`perl -0p` substitution edits the FIRST match in the file, which is routinely a different function with the same idiom, so the probe changes nothing relevant and its passing result reads as proof the test is worthless. A no-op probe is not evidence in either direction.
