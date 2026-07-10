#!/usr/bin/env bash
# PostToolUse(Write|Edit): when a plan file under .claude/plans/ is written, post/refresh
# the plan on its Linear issue and move the issue to In Progress. Idempotent via the
# plan-sync marker. The issue is taken from the plan FILENAME (NN-CAR-XX-slug.md), falling
# back to the branch — so it works even when the plan is authored on main.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/linear.sh
. "$DIR/lib/linear.sh"

payload=$(cat 2>/dev/null || echo '{}')
fp=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$fp" in
  */.claude/plans/*.md) ;;
  *) exit 0 ;;
esac
[ -f "$fp" ] || exit 0

ref=$(_ln_parse_ref "$(basename "$fp")"); [ -n "$ref" ] || ref=$(linear_issue_ref)
[ -n "$ref" ] || exit 0

body=$(printf '<!-- plan-sync -->\n📋 **Plan** — `%s`\n\n%s' "$(basename "$fp")" "$(cat "$fp")")
linear_upsert_comment "$ref" "plan-sync" "$body" || true
linear_set_state "$ref" "In Progress" || true
exit 0
