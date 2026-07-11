#!/usr/bin/env bash
# PostToolUse(Bash): when `gh pr merge` runs, flip the issue to Done. Primary source is the
# branch of the command's cd-target (compound `cd <worktree> && gh pr merge`) or the hook
# cwd; if neither carries a CAR-XX (e.g. merging by number from main), fall back to the
# PR's head branch via `gh pr view`, then to CAR-XX in the command text.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/linear.sh
. "$DIR/lib/linear.sh"

payload=$(cat 2>/dev/null || echo '{}')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
_ln_cmd_invokes "$cmd" 'gh pr merge' || exit 0

# Only a merge that actually happened moves the issue — gh prints "Merged pull request
# #N" on success (a queued --auto merge prints "will be automatically merged" and must
# NOT flip Done yet; neither should a failed merge or a quoted mention in other text).
out=$(printf '%s' "$payload" | jq -r '((.tool_response.stdout // "") + "\n" + (.tool_response.stderr // ""))' 2>/dev/null)
printf '%s' "$out" | grep -qi 'merged pull request' || exit 0

ref=$(linear_ref_for_cmd "$cmd")
if [ -z "$ref" ]; then
  # No ticket branch in the cd-target or hook cwd — ask gh which head branch the merged PR
  # had. Selector parsing is bounded to the args after `gh pr merge` (CAR-79); a numeric
  # selector needs repo context, so run gh from the cd-target when the command had one.
  sel=$(_ln_merge_selector "$cmd")
  dir=$(_ln_cmd_cd_dir "$cmd")
  head=$( { [ -n "$dir" ] && [ -d "$dir" ] && cd "$dir"; gh pr view ${sel:+"$sel"} --json headRefName -q .headRefName 2>/dev/null; } )
  ref=$(_ln_parse_ref "$head")
fi
[ -n "$ref" ] || ref=$(_ln_parse_ref "$cmd")
[ -n "$ref" ] || exit 0
linear_set_state "$ref" "Done" || _ln_fail_visible "$ref needs state set to Done"
exit 0
