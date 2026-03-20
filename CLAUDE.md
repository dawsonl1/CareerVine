# Agent Instructions

Read this entire file before starting any task.

## Self-Correcting Rules Engine

This file contains a growing ruleset that improves over time. **At session start, read the entire "Learned Rules" section before doing anything.**

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

## Learned Rules

<!-- New rules are appended below this line. Do not edit above this section. -->

1. [PROCESS] Always rephrase user-provided rules into precise, unambiguous language optimized for LLM instruction-following before appending them — because the user's phrasing may be conversational, and rules are most effective when written as clear, direct imperatives with explicit scope and rationale.

2. [PROCESS] Commit and push to remote frequently (after each meaningful change or logical unit of work) — because the user is working via SSH through VS Code and cannot run the dev server on this machine. They pull and test locally on a separate machine, so they need changes pushed promptly to iterate.

3. [CODE] When adding new functionality or modifying existing code, always ensure adequate test coverage exists for the changes and remove or update any stale tests that no longer reflect current behavior — because outdated tests give false confidence and missing tests let regressions slip through.

4. [PROCESS] After completing a change and writing/updating tests, always run the test suite (`npm run test` from the `careervine/` directory, which runs Vitest) and verify all tests pass before committing — because pushing broken tests defeats the purpose of having them and wastes the user's time when they pull to test locally.

5. [UX] Prioritize user experience above all else. Every UI decision must favor clean, intuitive design that serves real functionality and utility — never add visual clutter, unnecessary complexity, or decorative elements that don't help the user accomplish their goals. The product exists to meaningfully improve users' lives, so every interaction should feel effortless and purposeful.