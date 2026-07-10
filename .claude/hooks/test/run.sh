#!/usr/bin/env bash
# Pure-logic tests for the Linear lifecycle hooks — no API, no git state required.
# Run: bash .claude/hooks/test/run.sh
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$DIR/lib/linear.sh"

fail=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s (got: %q)\n' "$1" "$2"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1 (want %q)" "$3=$2"; }

# _ln_parse_ref: extracts + upcases CAR-XX from arbitrary strings
eq "parse branch"        "$(_ln_parse_ref 'dawson/car-33-worktree-lifecycle')" "CAR-33"
eq "parse filename"      "$(_ln_parse_ref '34-car-33-worktree-linear.md')"     "CAR-33"
eq "parse already upper" "$(_ln_parse_ref 'CAR-7-thing')"                      "CAR-7"
eq "parse multi picks 1" "$(_ln_parse_ref 'car-14-car-18-combo')"             "CAR-14"
eq "parse none -> empty" "$(_ln_parse_ref 'main')"                            ""

# linear_rank: forward-only ordering; terminal/unknown => -1
eq "rank Backlog"      "$(linear_rank Backlog)"        "0"
eq "rank In Progress"  "$(linear_rank 'In Progress')"  "2"
eq "rank In Review"    "$(linear_rank 'In Review')"    "3"
eq "rank Done"         "$(linear_rank Done)"           "4"
eq "rank Canceled=-1"  "$(linear_rank Canceled)"       "-1"

# downgrade guard is just: target rank must exceed current rank
[ "$(linear_rank 'In Review')" -gt "$(linear_rank 'In Progress')" ] && ok "In Review > In Progress" || bad "ordering" "bad"
[ "$(linear_rank 'In Progress')" -lt "$(linear_rank 'In Review')" ] && ok "no downgrade InReview->InProgress" || bad "ordering" "bad"

# key-absent safety: linear_gql must fail (return 1) without a key, never hang or emit stdout
( unset LINEAR_API_KEY; out=$(linear_gql 'query{__typename}' 2>/dev/null); rc=$?; [ $rc -ne 0 ] && [ -z "$out" ] ) \
  && ok "no key -> quiet failure" || bad "no-key path" "leaked"

[ "$fail" -eq 0 ] && { echo "ALL PASS"; exit 0; } || { echo "FAILURES"; exit 1; }
