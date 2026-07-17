# CAR-163 — Tune Dependabot: group, auto-merge safe, email on the rest

Keep Dependabot, make it quiet + useful. Follow-up from CAR-161 triage.

## Changes

1. **`.github/dependabot.yml`** (tune existing config):
   - Add a **react lockstep group** (react, react-dom, @types/react, @types/react-dom) in
     careervine AND panel-app, across all update types — kills the #119 split.
   - **Ignore `@modelcontextprotocol/sdk`** in careervine — it's pinned to mcp-handler's exact
     peer, so any bump breaks `npm ci` (this blocked the whole #122 group). Remove when
     mcp-handler widens its peer.
   - Keep existing weekly schedule, google-apis lockstep, minor-patch groups, github-actions group.

2. **`.github/workflows/dependabot-auto-merge.yml`** (new):
   - patch/minor Dependabot PR → `gh pr merge --auto --merge` (merges itself once web/mcp/extension
     checks pass).
   - major → email dawsonlpitcher@gmail.com ("needs a human").
   - any Dependabot PR whose CI fails → email ("can't auto-merge, CI failing").
   - `pull_request_target` for secrets+write token; NEVER checks out/runs PR code (safe pattern).
   - Emails sent via Resend (careervine.app verified sender) from dependabot@careervine.app.

3. **Repo wiring** (Claude does it, not a manual step):
   - Enable "Allow auto-merge" on the repo (`gh api -X PATCH ... allow_auto_merge=true`).
   - Add `RESEND_API_KEY` as a GitHub Actions secret (`gh secret set`, value never committed).

## Verify

- YAML valid (both files). ✔
- Send one live test email to dawsonlpitcher@gmail.com to prove the Resend pipe end-to-end.
- Confirm repo auto-merge on + secret present.
- Note: the workflow only runs once merged to the default branch (pull_request_target can't run
  against its own PR), so full auto-merge behavior is validated on the next real Dependabot PR.

## Guardrails

- Does not touch `ci.yml` (CAR-138 owns it).
- No product code; config + one workflow only.
- Security updates stay loud/immediate.
