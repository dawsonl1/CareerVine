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

ref=$(_ln_parse_ref "$(basename "$fp")")
if [ -z "$ref" ]; then
  # Ticket-less plans stamped HISTORICAL/SUPERSEDED are parked archive material,
  # not active plans. Never bind them via the branch fallback: on a ticket branch
  # that would OVERWRITE the ticket's real plan-sync comment with the archived
  # doc and flip the issue to In Progress (CAR-157).
  head -1 "$fp" | grep -qiE 'HISTORICAL|SUPERSEDED' && exit 0
  ref=$(linear_issue_ref)
fi
[ -n "$ref" ] || exit 0

body=$(printf '<!-- plan-sync -->\n📋 **Plan** — `%s`\n\n%s' "$(basename "$fp")" "$(cat "$fp")")
synced=1
linear_upsert_comment "$ref" "plan-sync" "$body" || synced=0
linear_set_state "$ref" "In Progress" || synced=0
[ "$synced" -eq 1 ] || _ln_fail_visible "$ref needs the plan posted as a <!-- plan-sync --> comment and state set to In Progress"
exit 0
