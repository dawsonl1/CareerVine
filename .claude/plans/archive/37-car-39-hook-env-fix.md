# CAR-39 — Fix silent Linear lifecycle hook failures in worktree sessions

## Diagnosis (from the CAR-37 session transcript)

The transcript of the failing session (`5614d66f…` in the `chrome-extension-review-6ad921`
worktree) shows the hooks **did fire** — `hook_success` attachments exist for both
`PostToolUse:Write` (plan write, 08:43) and `PostToolUse:Bash` (`gh pr create`, 08:59) —
and every invocation logged:

```
[linear-hook] LINEAR_API_KEY unset — skipping Linear sync
[linear-hook] CAR-37: not found
```

So all suspected causes are cleared:

- **Matchers / worktree paths** — fine; both hooks matched and executed in the worktree.
- **Branch rename mid-session** — red herring; `linear_issue_ref` reads the branch live via
  `git rev-parse` at hook time, and `on-plan-write.sh` takes the ref from the plan
  *filename* first anyway. The hook correctly resolved CAR-37 post-rename.
- **settings.json snapshot** — fine; the worktree checkout contained `.claude/settings.json`
  and the hooks from creation, and they were registered.

**Root cause:** hook processes inherit the **Claude Code app process environment**, not a
login shell. When the app is GUI-launched, `~/.zshenv` (→ `~/.config/claude/secrets.zsh`)
is never sourced, so `LINEAR_API_KEY` is absent in hook land — while every Bash-tool shell
*does* get it (the Bash tool initializes from the user profile), which is why manual
sourcing of `lib/linear.sh` worked fine in the same session. The lib's "quiet no-op when
the key is unset" design contract then hid the failure completely.

## Fix (two parts)

1. **Self-heal the env** — `lib/linear.sh` now, on load, extracts `LINEAR_API_KEY` (and
   only that key) from `~/.config/claude/secrets.zsh` when it's not already in the
   environment. Path overridable via `CLAUDE_SECRETS_FILE` for tests. Never clobbers an
   existing key, never imports the other secrets.
2. **Fail visible, not silent** — once a hook has matched and *should* sync, any failure
   now exits 2 (`_ln_fail_visible`), which surfaces the repair instruction to the agent
   (PostToolUse exit 2 feeds stderr back to the model without blocking the tool). No more
   silently-skipped flips. Non-matching invocations still exit 0 quietly.

## Files

- `.claude/hooks/lib/linear.sh` — self-heal block + `_ln_fail_visible` + contract comment.
- `.claude/hooks/on-plan-write.sh`, `on-pr-create.sh`, `on-pr-merge.sh` — track sync
  success, `_ln_fail_visible` on failure.
- `.claude/hooks/test/run.sh` — new tests: self-heal loads the key, imports only that key,
  never clobbers; fail-visible exits 2 with the repair hint; no-key quiet-failure test now
  isolated from the real secrets file.

## Verification

- `bash .claude/hooks/test/run.sh` — all pass.
- Live e2e: writing **this plan file** fires `on-plan-write.sh` in-session; CAR-39 must
  flip to In Progress with a `<!-- plan-sync -->` comment.
- GUI-env repro: `env -i HOME=… PATH=…` (no key) run of `on-plan-write.sh` must self-heal
  and sync; with `CLAUDE_SECRETS_FILE=/nonexistent` it must exit 2 with the repair hint.
- `gh pr create` at the end exercises `on-pr-create.sh` → CAR-39 In Review + PR link.
