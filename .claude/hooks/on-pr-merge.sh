#!/usr/bin/env bash
# PostToolUse(Bash): when `gh pr merge` runs, flip the issue to Done. Primary source is the
# current branch; if that carries no CAR-XX (e.g. merging by number from main), fall back to
# the PR's head branch via `gh pr view`.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/linear.sh
. "$DIR/lib/linear.sh"

payload=$(cat 2>/dev/null || echo '{}')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
printf '%s' "$cmd" | grep -q 'gh pr merge' || exit 0

ref=$(linear_issue_ref)
if [ -z "$ref" ]; then
  num=$(printf '%s' "$cmd" | grep -oE '[0-9]+' | head -1)
  head=$(gh pr view ${num:+"$num"} --json headRefName -q .headRefName 2>/dev/null)
  ref=$(_ln_parse_ref "$head")
fi
[ -n "$ref" ] || exit 0
linear_set_state "$ref" "Done" || _ln_fail_visible "$ref needs state set to Done"
exit 0
