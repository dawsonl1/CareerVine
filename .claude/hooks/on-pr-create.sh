#!/usr/bin/env bash
# PostToolUse(Bash): when `gh pr create` succeeds, flip the branch's Linear issue to
# In Review and record the PR link. Only fires when a PR URL appears in the output, so a
# failed/aborted create doesn't move the issue.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/linear.sh
. "$DIR/lib/linear.sh"

payload=$(cat 2>/dev/null || echo '{}')
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
printf '%s' "$cmd" | grep -q 'gh pr create' || exit 0

out=$(printf '%s' "$payload" | jq -r '((.tool_response.stdout // "") + "\n" + (.tool_response.stderr // ""))' 2>/dev/null)
url=$(printf '%s' "$out" | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+' | head -1)
[ -n "$url" ] || exit 0

ref=$(linear_issue_ref); [ -n "$ref" ] || exit 0
linear_set_state "$ref" "In Review" || true
linear_upsert_comment "$ref" "pr-link" "$(printf '<!-- pr-link -->\n🔀 **PR:** %s' "$url")" || true
exit 0
