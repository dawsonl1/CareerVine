# Learned Rules — Archive

Rules moved here verbatim from `CLAUDE.md` when superseded or fully absorbed into the `## Workflows` section. **Never deleted, numbering never reused** — this file is the audit trail the engine's never-delete convention requires. Do not treat archived rules as active instructions; the live `CLAUDE.md` always wins.

Archived 2026-07-09 (CLAUDE.md optimization pass):

---

2. [PROCESS] Commit and push to remote frequently (after each meaningful change or logical unit of work) — because the user is working via SSH through VS Code and cannot run the dev server on this machine. They pull and test locally on a separate machine, so they need changes pushed promptly to iterate.
   > ⚠️ SUPERSEDED by rule 15 (the SSH-era premise no longer holds — Claude runs directly on the Mac). The "commit/push frequently" habit still applies; the "can't run the dev server here / separate machine" reasoning does not.

6. [PROCESS] Always write implementation plans to `/home/braxtong/Dawson/CareerVine/.claude/plans/` as a markdown file before starting non-trivial features — because the user wants plans persisted and reviewable on disk, not just in conversation context.
   > ⚠️ CORRECTED by rule 21 / Workflows → Plan files. That absolute path is a stale SSH-era machine location; the real location is **repo-root `.claude/plans/`**. The "write a plan before non-trivial features" intent stands.

9. [PROCESS] Always number plan files in `.claude/plans/` with a two-digit sequential prefix (e.g., `19-feature-name.md`). Check the highest existing number and increment by one — because the user navigates plans by number, not alphabetically.
   > Absorbed into Workflows → Plan files (extended by rule 21 to embed the Linear ticket).

11. [PROCESS] Database migrations are applied to production by the user on their local machine via `git pull`, then `supabase db push` — because the user manages Supabase CLI auth and deployment locally. This machine should only create migration files and commit/push them.
    > ⚠️ SUPERSEDED by rule 15 — Claude now runs on the Mac with authenticated `supabase`/`vercel` CLIs and may apply migrations itself (dry-run first) when the user asks it to handle deployment end-to-end.

18. [PROCESS] Every task must have a Linear issue (team "Career Vine", prefix `CAR-`): create or reuse one at the start, set it In Progress and assign Dawson, update it at each meaningful step, and mark it Done when complete — because Dawson runs this project through Linear and wants live traceability, not just a final state. Standing order for all work, not a per-request instruction. See Workflows → Linear tickets.
    > Absorbed into Workflows → Linear tickets. Scope narrowed by rule 25 (product work only); status flips now automated by the lifecycle hooks on ticket-named branches.

19. [PROCESS] Choose the integration path by risk (see Workflows → Branching & PRs): small, single-file, no-schema, no-new-domain changes commit directly to `main` (rule 14); new feature domains, DB migrations, and multi-file/cross-cutting changes go on a `dawson/CAR-XX-slug` branch and merge via PR. Update a feature branch by merging `main` **into** it — never rebase or force-push `main` or any shared/already-pushed branch, because `main` is a live Vercel deploy target. Sync from `main` before opening a PR so conflicts surface early. Delete branches after they merge.
    > Absorbed into Workflows → Worktree lifecycle. Branch deletion is now owned by the `worktree-cleanup` skill (not done at merge time — no `--delete-branch`).

20. [PROCESS] On any git `CONFLICT` (merge/rebase/cherry-pick), the `merge-conflict-tool` plugin/skill is the required resolution process — never hand-resolve, never `git checkout --ours/--theirs` on a content conflict, never delete markers outside it. Install once via `/plugin marketplace add dawsonl1/merge-conflict-tool` + `/plugin install merge-conflict-tool@dawson-plugins` (interactive only); until then, load its `SKILL.md` from `~/Projects/claude-plugins/merge-conflict-tool` and follow it manually. See Workflows → Merge conflicts for the CareerVine calibration (verification commands, generated files, risky surfaces).
    > Absorbed into Workflows → Merge conflicts. Plugin installed user-scoped (v1.1.1) on 2026-07-09.

21. [PROCESS] Plan files live in repo-root `.claude/plans/` and are named `NN-CAR-XX-slug.md` — a two-digit sequential prefix (highest existing number + 1) plus the Linear ticket, one file per ticket, never reusing a number. Supersedes rule 6's stale `/home/braxtong/...` path and extends rule 9's numbering to embed the ticket. See Workflows → Plan files.
    > Absorbed into Workflows → Plan files.

22. [PROCESS] Name feature worktrees and branches after their Linear ticket — worktree dir `CAR-XX-slug`, branch `dawson/CAR-XX-slug` — because the `CAR-XX` in the branch name is what the lifecycle hooks (`.claude/hooks/`) parse to sync the right Linear issue automatically (plan→In Progress, PR create→In Review, PR merge→Done). A branch without a ticket reference gets no automatic Linear sync. See Workflows → Worktree lifecycle. (CAR-33)
    > Absorbed into Workflows → Worktree lifecycle.

23. [PROCESS] The moment a manual step for Dawson is identified (add an env var, run `supabase db push`, set a secret, redeploy, configure an external dashboard), record it on the Linear issue as a `<!-- manual-steps -->` checklist comment (upsert, don't duplicate) — because conversations and worktrees are disposable and get deleted; Linear is the durable record. The `worktree-cleanup` skill blocks teardown on unchecked items. Never let a manual step exist only in chat. (CAR-33)
    > Absorbed into Workflows → Worktree lifecycle (manual-steps paragraph + Linear automation).

---

Archived 2026-07-19 (CAR-157 docs purge — absorbed into Workflows → Docs & copy drift):

34. [PROCESS] Whenever a change alters the user-visible behavior of any surface described on docs.careervine.app (source: `careervine/public/docs/index.html`), update that page's copy in the same branch/PR as the behavior change — check the page proactively on every user-facing change, without being asked — because the docs subdomain is the product's public reference and it silently drifts stale otherwise (the page deploys with the app, so a behavior change merged without a copy update ships wrong documentation). (Preference set by Dawson, 2026-07-11, during CAR-76.)
    > Absorbed into Workflows → Docs & copy drift, which extends it with the qstash-schedules cadence trigger and the conventions-doc surface.

46. [PROCESS] Any change to what CareerVine persists about users or third parties — a new stored field, table, cache, log, third-party processor, or a change to deletion/retention behavior — must update the privacy policy (`careervine/src/app/privacy/page.tsx`) in the same branch/PR, checked proactively without being asked — because the policy is a public commitment that silently drifts false otherwise, and Google/Chrome-Web-Store verification both audit it against actual behavior. Extends rule 34's docs-drift guard to the privacy surface; rule 35 (no em dashes) applies to the page copy. (CAR-156, 2026-07-19.)
    > Absorbed into Workflows → Docs & copy drift alongside rule 34.
