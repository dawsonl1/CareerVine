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
eq "parse no substring"  "$(_ln_parse_ref 'oscar-12-notes.md')"               ""
eq "parse no calendar"   "$(_ln_parse_ref 'historical-google-calendar-plan.md')" ""

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
# (CLAUDE_SECRETS_FILE pointed at a missing file so self-heal can't reload the real key)
( unset LINEAR_API_KEY; export CLAUDE_SECRETS_FILE=/nonexistent
  . "$DIR/lib/linear.sh"
  out=$(linear_gql 'query{__typename}' 2>/dev/null); rc=$?; [ $rc -ne 0 ] && [ -z "$out" ] ) \
  && ok "no key -> quiet failure" || bad "no-key path" "leaked"

# self-heal (CAR-39): with no key in the env, sourcing the lib recovers it from the
# secrets file — hooks inherit the GUI app env, which never sourced ~/.zshenv.
tmpsecrets=$(mktemp)
printf 'export SOME_OTHER_KEY="nope"\nexport LINEAR_API_KEY="test-key-123"  # trailing comment\n' > "$tmpsecrets"
got=$( unset LINEAR_API_KEY; export CLAUDE_SECRETS_FILE="$tmpsecrets"
  . "$DIR/lib/linear.sh"; printf '%s' "${LINEAR_API_KEY:-}" )
eq "self-heal loads key from secrets file" "$got" "test-key-123"
got=$( unset LINEAR_API_KEY; export CLAUDE_SECRETS_FILE="$tmpsecrets"
  . "$DIR/lib/linear.sh"; printf '%s' "${SOME_OTHER_KEY:-}" )
eq "self-heal imports ONLY the Linear key" "$got" ""
got=$( LINEAR_API_KEY="already-set" ; export LINEAR_API_KEY; export CLAUDE_SECRETS_FILE="$tmpsecrets"
  . "$DIR/lib/linear.sh"; printf '%s' "$LINEAR_API_KEY" )
eq "self-heal never clobbers an existing key" "$got" "already-set"
rm -f "$tmpsecrets"

# _ln_fail_visible: exits 2 (PostToolUse's surface-to-agent code) with the repair hint on stderr
err=$( ( _ln_fail_visible "CAR-1 needs X" ) 2>&1 ); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$err" | grep -q 'repair via Linear MCP: CAR-1 needs X' \
  && ok "fail-visible exits 2 with repair hint" || bad "fail-visible" "rc=$rc err=$err"

# _ln_cmd_invokes: command must INVOKE the verb, not merely mention it in quoted text —
# a gh pr create whose --body documented `gh pr merge` flipped CAR-79 to Done live.
inv() { _ln_cmd_invokes "$1" "$2" && echo yes || echo no; }
eq "invoke at start"          "$(inv 'gh pr merge 46 --merge' 'gh pr merge')"            "yes"
eq "invoke after cd &&"       "$(inv 'cd /wt && gh pr merge 46' 'gh pr merge')"          "yes"
eq "invoke after ;"           "$(inv 'cd /wt; gh pr create -t x' 'gh pr create')"        "yes"
eq "invoke inside \$( )"      "$(inv 'url=$(gh pr create -t x)' 'gh pr create')"         "yes"
eq "quoted mention no match"  "$(inv 'gh pr create --title x --body "bounds the args after gh pr merge at operators"' 'gh pr merge')" "no"
eq "longer verb no match"     "$(inv 'gh pr merger 4' 'gh pr merge')"                    "no"

# _ln_cmd_cd_dir: cd-target of a compound command (CAR-79)
eq "cd-dir bare path"     "$(_ln_cmd_cd_dir 'cd /a/b/wt && gh pr create --title x')" "/a/b/wt"
eq "cd-dir double-quoted" "$(_ln_cmd_cd_dir 'cd "/a b/wt" && gh pr create')"         "/a b/wt"
eq "cd-dir single-quoted" "$(_ln_cmd_cd_dir "cd '/a b/wt' && gh pr merge 4")"        "/a b/wt"
eq "cd-dir semicolon"     "$(_ln_cmd_cd_dir 'cd /wt; gh pr create')"                 "/wt"
eq "cd-dir leading space" "$(_ln_cmd_cd_dir '  cd /wt && ls')"                       "/wt"
eq "no cd -> empty"       "$(_ln_cmd_cd_dir 'gh pr create --title x')"               ""
eq "mid-cmd cd ignored"   "$(_ln_cmd_cd_dir 'ls && cd /wt')"                         ""

# _ln_merge_selector: PR selector only from args after `gh pr merge` — never from a
# worktree path earlier in the command (the CAR-79 wrong-number trap)
eq "merge sel number"        "$(_ln_merge_selector 'gh pr merge 46 --merge')"        "46"
eq "merge sel after cd path" "$(_ln_merge_selector 'cd .claude/worktrees/CAR-78-x && gh pr merge 46 --merge')" "46"
eq "merge sel url"           "$(_ln_merge_selector 'gh pr merge https://github.com/o/r/pull/45 --merge')" "https://github.com/o/r/pull/45"
eq "merge sel none"          "$(_ln_merge_selector 'cd .claude/worktrees/CAR-78-x && gh pr merge --merge')" ""
eq "merge sel stops at &&"   "$(_ln_merge_selector 'gh pr merge --merge && echo 99')" ""

# linear_issue_ref with an explicit dir + linear_ref_for_cmd end-to-end (throwaway repos)
tmp=$(mktemp -d)
git init -q -b main "$tmp/main-co" && git -C "$tmp/main-co" commit -q --allow-empty -m init
git -C "$tmp/main-co" worktree add -q "$tmp/wt" -b dawson/CAR-78-speedups main
eq "issue_ref dir arg (ticket)" "$(linear_issue_ref "$tmp/wt")"      "CAR-78"
eq "issue_ref dir arg (main)"   "$(linear_issue_ref "$tmp/main-co")" ""
got=$(cd "$tmp/main-co" && linear_ref_for_cmd "cd $tmp/wt && gh pr create --title 'x (CAR-78)'")
eq "ref_for_cmd prefers cd-target over main cwd" "$got" "CAR-78"
got=$(cd "$tmp/wt" && linear_ref_for_cmd "gh pr create --title x")
eq "ref_for_cmd falls back to cwd branch" "$got" "CAR-78"

# Regression (CAR-79): on-pr-create must NOT silently skip a compound `cd <wt> && gh pr
# create` run with the hook cwd on main. With no API key it must resolve CAR-78 and fail
# VISIBLY (exit 2), where the old code exited 0 without a word.
payload=$(jq -n --arg cmd "cd $tmp/wt && gh pr create --title 'Speedups (CAR-78)' --body x" \
  '{tool_name:"Bash",tool_input:{command:$cmd},tool_response:{stdout:"https://github.com/o/r/pull/45\n",stderr:""}}')
err=$(cd "$tmp/main-co" && printf '%s' "$payload" \
  | env -u LINEAR_API_KEY CLAUDE_SECRETS_FILE=/nonexistent bash "$DIR/on-pr-create.sh" 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$err" | grep -q 'CAR-78' \
  && ok "pr-create resolves ref through compound cd (exit 2, not silent 0)" \
  || bad "pr-create compound-cd regression" "rc=$rc err=$err"
# Regression (CAR-79 live): a `gh pr create` whose --body mentions "gh pr merge" must NOT
# trigger the merge hook, even from a ticket-branch cwd (it flipped CAR-79 to Done).
payload=$(jq -n \
  '{tool_name:"Bash",tool_input:{command:"gh pr create --title \"x (CAR-78)\" --body \"parses the args after gh pr merge only\""},tool_response:{stdout:"https://github.com/o/r/pull/45\n",stderr:""}}')
err=$(cd "$tmp/wt" && printf '%s' "$payload" \
  | env -u LINEAR_API_KEY CLAUDE_SECRETS_FILE=/nonexistent bash "$DIR/on-pr-merge.sh" 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 0 ] && [ -z "$err" ] \
  && ok "merge hook ignores quoted 'gh pr merge' in a create's body" \
  || bad "merge-hook quoted-text regression" "rc=$rc err=$err"

# A real merge invocation whose output does NOT confirm the merge (failed / --auto queued)
# must not flip Done either.
payload=$(jq -n \
  '{tool_name:"Bash",tool_input:{command:"gh pr merge 45 --auto --merge"},tool_response:{stdout:"",stderr:"! Pull request #45 will be automatically merged when all requirements are met\n"}}')
err=$(cd "$tmp/wt" && printf '%s' "$payload" \
  | env -u LINEAR_API_KEY CLAUDE_SECRETS_FILE=/nonexistent bash "$DIR/on-pr-merge.sh" 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 0 ] && [ -z "$err" ] \
  && ok "merge hook requires 'Merged pull request' in output" \
  || bad "merge-hook output-guard" "rc=$rc err=$err"

# ...and a confirmed merge through a compound cd still resolves the ref and syncs
# (exit 2 loudly here, since the API key is withheld).
payload=$(jq -n --arg cmd "cd $tmp/wt && gh pr merge 45 --merge" \
  '{tool_name:"Bash",tool_input:{command:$cmd},tool_response:{stdout:"",stderr:"✓ Merged pull request #45 (Speedups)\n"}}')
err=$(cd "$tmp/main-co" && printf '%s' "$payload" \
  | env -u LINEAR_API_KEY CLAUDE_SECRETS_FILE=/nonexistent bash "$DIR/on-pr-merge.sh" 2>&1 >/dev/null); rc=$?
[ "$rc" -eq 2 ] && printf '%s' "$err" | grep -q 'CAR-78' \
  && ok "merge hook resolves ref through compound cd on a confirmed merge" \
  || bad "merge-hook compound-cd" "rc=$rc err=$err"

git -C "$tmp/main-co" worktree remove --force "$tmp/wt" 2>/dev/null; rm -rf "$tmp"

[ "$fail" -eq 0 ] && { echo "ALL PASS"; exit 0; } || { echo "FAILURES"; exit 1; }
