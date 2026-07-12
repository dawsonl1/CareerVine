# Agent Instructions

Read both sections below before starting any task.

## Self-Correcting Rules Engine

Two authoritative parts:

- **`## Workflows`** — canonical process, edited in place to stay current. **On any overlap or conflict with a Learned Rule, Workflows wins** (rules absorbed there are archived).
- **`## Learned Rules`** — append-only log of corrections and preferences. Between conflicting rules, the higher number (newer) wins.

### How it works

1. When Dawson corrects you, rejects an approach, states a preference, or a wrong assumption causes a bug: **immediately append a rule**, rephrased as a precise imperative — `N. [CATEGORY] Never/Always do X — because Y.` Categories: `[STYLE] [CODE] [ARCH] [TOOL] [PROCESS] [DATA] [UX] [OTHER]`.
2. **Never delete or renumber.** An obsolete rule gets a newer superseding rule (or an inline ⚠️ note). A rule fully absorbed into Workflows or superseded moves **verbatim** to `.claude/rules-archive.md` — the numbering gap stays, the audit trail survives.

---

## Workflows

Canonical, stable process for this project — edited in place to stay accurate, and authoritative over older Learned Rules. Rules fully absorbed here live in `.claude/rules-archive.md`.

### Linear tickets

Project is managed through Linear — team **"Career Vine"**, ticket prefix **`CAR-`**. All **product work** happens on a ticket (app, extension, MCP server, migrations, shipped tooling); meta-work on agent process files (CLAUDE.md, memory, config) needs none (rule 25).

1. **Before starting any task**, search existing issues (`list_issues`, team "Career Vine"). Reuse a relevant ticket if one exists; otherwise create one in the "Career Vine" team, assigned to Dawson.
2. **Status flips and plan/PR posts are automated** on ticket-named branches — see "Linear automation" under Worktree lifecycle. Don't do the hooks' job by hand; do verify it happened.
3. **You still own the rich updates**: progress comments at meaningful steps (slice landed, tests passing), the `manual-steps` checklist, and everything on `main` or non-ticket branches (there, handle status flips yourself via MCP).

### Worktree lifecycle (branching & PRs)

Feature work happens in **worktrees off `main`**, one Linear issue per worktree, with Linear kept in sync automatically by the hooks in `.claude/hooks/` (registered in `.claude/settings.json`, powered by `$LINEAR_API_KEY`). The lifecycle:

1. **Open** — `git worktree add .claude/worktrees/CAR-XX-slug -b dawson/CAR-XX-slug main`. Worktree dir and branch are **both named after the ticket** — the branch name is what binds every automatic Linear update to the right issue. If no issue exists yet, create one first.
2. **Plan** — write `.claude/plans/NN-CAR-XX-slug.md`. *(Hook: plan is posted to the issue + issue flips to In Progress.)*
3. **Implement** — build, test, fix. Commit/push to the feature branch freely.
4. **PR** — sync from `main` first (merge it **into** the branch), confirm tests pass (rule 4), then `gh pr create` with `(CAR-XX)` in the title (established convention, e.g. `Add BYO Deepgram API key for transcription (CAR-30)`) and a body covering what/why and how it was verified. *(Hook: issue flips to In Review + PR link recorded.)* Opening the PR is the end of the agent's autonomous path — stop here and wait.
5. **Merge** — **only on Dawson's explicit go-ahead, per PR. Rule 14's auto-push authority covers direct commits, NOT merging PRs — never self-merge.** Then `gh pr merge --merge` (merge commit; never rebase; no `--delete-branch` — the cleanup skill owns branch deletion). **Merging deploys production** via Vercel: if the PR contains migrations, Claude applies them itself immediately after merging — `supabase db push --dry-run`, review the plan, then `supabase db push` (rule 27; Dawson never runs supabase commands). *(Hook: issue flips to Done.)*
6. **Clean up** — when Dawson says "clean up this worktree", run the **`worktree-cleanup` skill** (`.claude/skills/worktree-cleanup/`). It gates deletion on: PR merged, tree clean, issue Done, and **all manual steps surfaced** — then removes the worktree and both branches.

**Risk-based exception:** small, single-file, no-schema, no-new-domain changes may commit directly to `main` (rule 14) without a worktree.

**Never** rebase or force-push `main` or any shared/already-pushed branch. Keep branches current by merging `main` in, so conflicts surface early (where the merge-conflict tooling engages).

**Manual steps are Linear's, not the conversation's:** anything Dawson must genuinely do by hand (OAuth grants, external dashboards, values only he can obtain) gets upserted to the issue as a `<!-- manual-steps -->` checklist the moment it's identified — conversations get deleted; Linear survives. Migrations and Vercel env vars are never on this list — Claude handles both (rules 27–28).

**Linear automation — how to work with it:**

- **Hooks own** (only on branches containing `CAR-XX`): plan post + In Progress on plan write; In Review + PR link on `gh pr create`; Done on `gh pr merge`. **Don't duplicate these** — no manual state flips or plan-posting at those moments.
- **Agents own**: creating/choosing the issue, progress comments at meaningful steps, the `manual-steps` checklist, and all Linear updates when the automation can't bind (work on `main`, branch without `CAR-XX`).
- **Comment markers** — issue comments are upserted, keyed by an HTML marker on the first line: `<!-- plan-sync -->` (plan), `<!-- pr-link -->` (PR URL), `<!-- manual-steps -->` (Dawson's checklist), `<!-- progress -->` (status summary). Reuse these markers (via MCP or `.claude/hooks/lib/linear.sh`'s `linear_upsert_comment`) instead of posting duplicate comments.
- **Hooks fail silent by design** (missing `$LINEAR_API_KEY`, unnamed branch, API hiccup) so they never block git. So **verify, don't assume**: after a plan write / PR create / PR merge, check the issue state and repair via MCP if a flip was missed. State changes only move forward (Backlog→Todo→In Progress→In Review→Done); hooks never downgrade, and neither should you without Dawson asking.

### Merge conflicts → `merge-conflict-tool` plugin

On **any** git `CONFLICT` (merge, rebase, or cherry-pick), the **`merge-conflict-tool`** skill is the required resolution process. Do **not** hand-resolve, do **not** `git checkout --ours/--theirs` on a content conflict, and do **not** delete conflict markers manually outside that workflow.

**Setup (one-time, interactive — cannot be done from a non-interactive session):**

```
/plugin marketplace add dawsonl1/merge-conflict-tool
/plugin install merge-conflict-tool@dawson-plugins
```

Once installed, its hooks auto-invoke on any conflict. **If you hit a conflict and the skill isn't installed in the current environment**, load and follow it manually from `~/Projects/claude-plugins/merge-conflict-tool/plugins/merge-conflict-tool/skills/merge-conflict-tool/SKILL.md`.

**CareerVine calibration for the skill:**

- **Verification commands:** `npm run test` and `npm run build`, both run from `careervine/`; plus the Supabase migration consistency check whenever migrations are touched.
- **Generated files — never hand-merge, regenerate instead:** `careervine/**/database.types.ts` (regenerate via `supabase gen types`) and the lockfile.
- **Risky surfaces (extra care / halt-and-ask):** Supabase migrations (see rules 10 + 12), MCP OAuth/bearer auth, bundle billing, `vercel.json` / deploy config, and secrets.
- Visual verification uses the Playwright MCP (installed) — required for any frontend change in the merge result.

### Plan files

- **Location:** repo-root `.claude/plans/`.
- **Naming:** `NN-CAR-XX-slug.md` — a two-digit sequential prefix (highest existing number + 1) plus the Linear ticket, e.g. `31-car-18-add-companies-without-contacts.md`. One plan file per ticket; never reuse a number.
- Write a plan before starting any non-trivial feature.

### Testing, deploy & QA (pointers)

- Run `npm run test` (Vitest) from `careervine/` and ensure coverage for new/changed code before committing (rules 3, 4).
- Don't browser-verify every UI change — reserve previews for high-risk work (rule 13).
- Push to `main` auto-deploys; env-var changes require a redeploy, empty commit being the established pattern (rule 16). Migrations: Claude applies them itself on landing — dry-run then `supabase db push` (rule 27); never ad-hoc SQL (rule 10).

---

## Learned Rules

<!-- New rules are appended below this line. Do not edit above this section. -->

> **Archived:** rules 2, 6, 9, 11, 18–23 (superseded or absorbed into Workflows) → `.claude/rules-archive.md`, verbatim. Numbering is never reused — next new rule is 26.

1. [PROCESS] Always rephrase user-provided rules into precise, unambiguous language optimized for LLM instruction-following before appending them — because the user's phrasing may be conversational, and rules are most effective when written as clear, direct imperatives with explicit scope and rationale.

3. [CODE] When adding new functionality or modifying existing code, always ensure adequate test coverage exists for the changes and remove or update any stale tests that no longer reflect current behavior — because outdated tests give false confidence and missing tests let regressions slip through.

4. [PROCESS] After completing a change and writing/updating tests, always run the test suite (`npm run test` from the `careervine/` directory, which runs Vitest) and verify all tests pass before committing — because pushing broken tests defeats the purpose of having them and wastes the user's time when they pull to test locally.

5. [UX] Prioritize user experience above all else. Every UI decision must favor clean, intuitive design that serves real functionality and utility — never add visual clutter, unnecessary complexity, or decorative elements that don't help the user accomplish their goals. The product exists to meaningfully improve users' lives, so every interaction should feel effortless and purposeful.

7. [PROCESS] After completing a user-facing feature, update the project README to reflect the new capability from a product perspective — describe what the feature does for the user and why it matters, not implementation details. The README should read like a product page that sells the app's value, not a technical changelog.

8. [PROCESS] Always run `git pull` before pushing — because the user frequently pushes empty commits from their local machine to retrigger Vercel deployments (hobby plan limitation), which causes the remote to diverge from this machine's local history. A pre-push pull prevents rejected pushes.

10. [DATA] Never run SQL directly against the production Supabase database — because ad-hoc queries bypass migration tracking and can cause schema drift. All schema changes must go through migration files only.

12. [DATA] Never assume a schema/types mismatch means the types file is wrong — check `git log --all -- "*.sql"` for deleted migrations first. Migrations originally lived at `careervine/supabase/migrations/` and moved to root `supabase/migrations/`; `20250217_add_location_to_contact_companies.sql` was deleted in that move (commit `9c718fe`) without being re-created, so `contact_companies.location` existed in production untracked until re-added in `20260707000000_company_pages_and_scrape_import.sql`. Production may contain schema from other lost migrations.

13. [PROCESS] Do not verify every UI change with browser previews and screenshots by default — the user reviews changes themselves, and repeated preview/screenshot cycles slow the iteration loop. Use the preview browser only for high-risk changes (layout restructuring, breakpoint logic), when the user explicitly asks for verification, or when debugging requires observing runtime behavior.

14. [PROCESS] When a task includes code or migration changes, automatically commit and push completed, validated work to `main` without asking for additional confirmation — because the user explicitly prefers an automatic commit/push workflow instead of repeated approval prompts.
    > ⚠️ Scope (2026-07-09): this authority covers **direct commits** on the risk-based path (Workflows → Worktree lifecycle) — it does NOT extend to merging PRs (never self-merge) and does not bypass the worktree+PR path for feature domains, migrations, or multi-file changes.

15. [PROCESS] Claude Code now runs directly on the user's Mac with authenticated `supabase` and `vercel` CLIs (supersedes the SSH-era assumptions behind rules 2 and 11): when the user explicitly asks Claude to handle deployment end-to-end, Claude may verify/apply migrations (`supabase db push`, dry-run first) and trigger/monitor Vercel deployments itself — because the user granted this on 2026-07-09 ("do everything for me") and the local environment has the required auth.
    > ⚠️ The "when explicitly asked" condition is SUPERSEDED by rule 27 — applying migrations is now standing authority, no per-task request needed.

16. [PROCESS] Vercel Git auto-deployments on `main` are re-enabled as of 2026-07-09 (the `vercel.json` that disabled them was deleted): every push to `main` deploys production automatically, and environment-variable changes take effect only on the next deployment — so after changing Vercel env vars, trigger a redeploy (empty commit is the established pattern) before relying on them.

17. [CODE] Never detect the success of a conditional Supabase UPDATE via `.select()` on the same query when the update modifies a column that the query's filters test (CAS/claim patterns like `update({lock: x}).is("lock", null).select()`) — PostgREST re-applies the request filters to the RETURNING representation, so a successful update returns empty rows and reads as a failure. Use `.update(payload, { count: "exact" })` and check the count instead. Found live on the first bundle publish (2026-07-09); the same trap silently zeroed finalizePublish's removal count.

24. [PROCESS] Dawson intentionally pastes secret values into chat for Claude to handle — store them in `~/.config/claude/secrets.zsh`, wire them up, and move on. Do not treat pasted secrets as compromised, do not recommend rotation, do not add security caveats about it. (Preference set 2026-07-09; also reflected in global CLAUDE.md Secret handling.)

25. [PROCESS] Linear tickets (rule 18) are required only for work on the product itself — the CareerVine app, extension, MCP server, migrations, and repo tooling that ships with it. Meta-work on agent process files (CLAUDE.md audits/edits, memory, agent config housekeeping) needs no ticket — because Linear tracks the website/product, not Claude's own process maintenance. Narrows rule 18's "every task." (Correction from Dawson, 2026-07-09.)

26. [PROCESS] Never ask Dawson to do something Claude can do itself — exhaust the shell, authenticated CLIs (`gh`, `supabase`, `vercel`, `claude`), the keys in `secrets.zsh`, MCP connectors, and browser control before delegating anything to him. Interactive-looking tasks usually have non-interactive equivalents (`/plugin` TUI ≙ `claude plugin` CLI). Only hand him what genuinely requires him (a decision, an OAuth prompt, a value only he can obtain), request the minimal input rather than a procedure, and state why it can't be done for him — because Dawson's time is the scarce resource and self-service is the point of the agent. (Preference set 2026-07-09; also in global CLAUDE.md preferences.)

27. [PROCESS] Claude applies Supabase migrations itself as **standing authority** — Dawson never runs `supabase` commands. Supersedes rule 15's "when explicitly asked" condition. The moment migration-carrying work lands on `main` (PR merge or direct commit), run `supabase db push --dry-run`, review the plan, then `supabase db push` — and never put `supabase db push` on Dawson's manual-steps checklist again. Rule 10 stands untouched: schema changes go through migration files only, never ad-hoc SQL. (Correction from Dawson, 2026-07-09.)

28. [PROCESS] Claude manages Vercel environment variables itself — never put them on Dawson's manual-steps checklist. From `careervine/` (project `careervine`, `prj_olcHrQsp`): `printf '%s' "$VALUE" | vercel env add NAME production` to set, `vercel env rm` to remove, `vercel env ls` to audit; then trigger the redeploy env changes require (rule 16 — empty commit is the pattern). CLI is installed globally and authenticated as `dawsonlpitcher-1930`. Extends rule 27's spirit: deploy-surface config is Claude's job, not Dawson's. (Correction from Dawson, 2026-07-09.)

29. [TOOL] Always call production CareerVine APIs at `https://www.careervine.app`, never the apex `https://careervine.app` — the apex 307-redirects to www, and fetch/undici strips the `Authorization` header on the cross-origin hop, so every bearer-authenticated call fails as an inscrutable 401 while unauthenticated probes look fine. Cost ~40 minutes of env-var false debugging during the CAR-35 rollout (2026-07-10); `scripts/publish-bundle.mjs` now fails loudly on any redirect. Also note: this Vercel team stores env vars as "sensitive" — values can never be read back via `vercel env pull` (everything pulls as `""`), so verify env values by fingerprinting through the REST API on an `encrypted`-type copy, or by behavior, never by pull.

30. [TOOL] Never assume Claude Code hooks inherit shell environment variables — hook processes get the **app process env**, and a GUI-launched app never sources `~/.zshenv`/`secrets.zsh`, so keys present in every Bash-tool shell can be absent in hooks (this silently broke all Linear lifecycle hooks in the CAR-37 session; fixed in CAR-39). Any hook needing a secret must self-load it (see `lib/linear.sh`'s self-heal from `~/.config/claude/secrets.zsh`), and once a hook has matched, a failed sync must exit 2 so the failure surfaces to the agent instead of skipping silently. Related: Linear's GitHub "start" automation raced these hooks and downgraded issues — team git automations now only map `review` and `merge`; don't re-add `start`.

31. [PROCESS] When Dawson asks to brainstorm, stay in brainstorm mode until he explicitly signs off on the design — walk him through every meaningful option with trade-offs (including choices Claude would otherwise make unilaterally), and cover the full problem space (e.g. for analytics: not just architecture but also which metrics to measure), before writing any implementation code. A couple of multiple-choice questions is one step of a brainstorm, not the whole thing. (Correction from Dawson, 2026-07-10.)

32. [DATA] Never treat `supabase db push --dry-run` as validation that a migration's SQL is correct — it only lists which migrations would be pushed; it never executes SQL, so it cannot catch references to dropped tables/columns or any schema incompatibility. When auditing migrations, account for DROP TABLE/COLUMN history, not just what was created (`ALTER TABLE x` fails hard if `x` was dropped by an earlier migration — `IF EXISTS` on the constraint does not guard the table). The sanctioned pre-apply validation is executing the migration against production inside `BEGIN; SET LOCAL lock_timeout='3s'; … ROLLBACK;` — zero drift, proves it applies against real schema and data (this is validation, not a rule-10 violation). Caught live on CAR-66 (2026-07-10): the draft migration referenced `post_meeting_action_items`, dropped five months earlier; dry-run passed, the rolled-back apply test caught it.

33. [TOOL] Never put `rewrites`/`redirects`/`headers` in `vercel.json` for this app — Vercel ignores them on Next.js projects, silently: the deploy succeeds and the routing rule simply doesn't exist. Define routing in `next.config.ts` (`rewrites().beforeFiles` for host-scoped rules like the docs.careervine.app → `/docs/index.html` rewrite). Verify host-based rewrites locally with `next build && next start` + `curl -H "Host: docs.careervine.app" localhost:3000/` before shipping, and always re-verify the production URL after deploy — the CAR-71 docs subdomain shipped "green" (build, tests, DNS, domain all passing) while serving the wrong content (2026-07-11).

34. [PROCESS] Whenever a change alters the user-visible behavior of any surface described on docs.careervine.app (source: `careervine/public/docs/index.html`), update that page's copy in the same branch/PR as the behavior change — check the page proactively on every user-facing change, without being asked — because the docs subdomain is the product's public reference and it silently drifts stale otherwise (the page deploys with the app, so a behavior change merged without a copy update ships wrong documentation). (Preference set by Dawson, 2026-07-11, during CAR-76.)

35. [STYLE] Never use em dashes (—) in user-facing copy anywhere on the website — this covers all rendered UI text, marketing/landing copy, the docs page (`careervine/public/docs/index.html`), emails, and any other product surface a user reads. Rewrite with a comma, colon, parentheses, or separate sentences instead. Scope is user-facing copy only: code, comments, commit messages, Linear/PR text, and these agent process files are unaffected. (Preference set by Dawson, 2026-07-11.)

36. [PROCESS] Once Dawson has explicitly chosen among options you laid out, treat the decision as final and build it — surface a genuinely new consideration at most ONCE, and if he reaffirms, stop and implement without further comparisons or re-recommendations. Complements rule 31: brainstorm fully BEFORE the decision, commit fully AFTER. (During CAR-105 design Dawson picked the active-aware expiry model; re-recommending the simpler model after his pick, then again after he added the greyed-but-sendable requirement, made him repeat "do what I asked please" — re-defending a settled call wastes the scarce resource, his time.) (Correction from Dawson, 2026-07-12.)

37. [PROCESS] Never raise an alarm about repository or `main` integrity (divergence, drift, "wrong"/stale state, missing content) from a proxy signal like a line count or a failed offset-read — verify by direct comparison FIRST (`git rev-parse <ref>:<path>` blob hashes across refs, `git diff`, `git show`). A false "main's CLAUDE.md has diverged across branches" claim, drawn from an off-by-one line-count misread, interrupted CAR-105 to chase a non-issue that a one-command hash comparison disproved (all refs byte-identical). Generalizes: don't surface a scary claim you haven't actually checked. (2026-07-12.)
