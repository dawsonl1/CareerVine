#!/usr/bin/env bash
# Shared helpers for CareerVine's worktree → Linear → PR lifecycle hooks (CAR-33).
# Deterministic status flips + idempotent comment upserts against Linear's GraphQL API.
#
# Design contract: functions never block or slow the git action (PostToolUse runs after
# the tool anyway). When sync genuinely can't run, the HOOK exits 2 so the failure is
# surfaced to the agent for manual repair via MCP — silent skips hid real failures (CAR-39).

LINEAR_API="https://api.linear.app/graphql"

_ln_log() { printf '[linear-hook] %s\n' "$*" >&2; }

# Hook processes inherit the Claude Code APP env, not a login shell — when the app is
# GUI-launched, ~/.zshenv (→ secrets.zsh) was never sourced, so LINEAR_API_KEY can be
# absent even though every Bash-tool shell has it (root cause of CAR-39). Self-heal by
# extracting just this one key from the canonical secrets file — never import the rest.
_LN_SECRETS="${CLAUDE_SECRETS_FILE:-$HOME/.config/claude/secrets.zsh}"
if [ -z "${LINEAR_API_KEY:-}" ] && [ -r "$_LN_SECRETS" ]; then
  eval "$(grep -E '^[[:space:]]*(export[[:space:]]+)?LINEAR_API_KEY=' "$_LN_SECRETS" 2>/dev/null | tail -1)" 2>/dev/null || true
  [ -n "${LINEAR_API_KEY:-}" ] && export LINEAR_API_KEY
fi

# For hooks: emit a repair instruction the agent will see (PostToolUse exit 2 feeds
# stderr back to the model without blocking anything) and exit 2. $*=what to repair.
_ln_fail_visible() {
  _ln_log "SYNC FAILED — repair via Linear MCP: $*"
  exit 2
}

# Pure parser: extract CAR-XX from any string (branch, filename), upcased. Empty if none.
# Exposed (underscore-prefixed) so tests can exercise it without a repo/API.
# Boundary-anchored so an embedded substring ("oscar-12-notes.md") never binds a
# ticket — only car-N at the start or after a non-alphanumeric separator counts.
_ln_parse_ref() {
  printf '%s' "$1" | grep -oiE '(^|[^[:alnum:]])car-[0-9]+' | head -1 \
    | grep -oiE 'car-[0-9]+' | tr '[:lower:]' '[:upper:]'
}

# CAR-XX from the git branch of $1 (a directory), or of the current cwd when omitted.
linear_issue_ref() {
  local dir="${1-}" branch
  branch=$(git ${dir:+-C "$dir"} rev-parse --abbrev-ref HEAD 2>/dev/null) || return 0
  _ln_parse_ref "$branch"
}

# Target dir of a leading `cd <dir>` in a compound command (bare, "..." or '...' quoted).
# Empty when the command doesn't start with cd. A `cd <worktree> && gh ...` call operates
# on a different checkout than the hook cwd — the cd target is where the branch that binds
# the Linear issue actually lives (CAR-79).
_ln_cmd_cd_dir() {
  printf '%s' "$1" | sed -nE \
    's/^[[:space:]]*cd[[:space:]]+("([^"]*)"|'\''([^'\'']*)'\''|([^&;|[:space:]]+)).*/\2\3\4/p'
}

# Resolve CAR-XX for a Bash tool command: the branch of the dir a leading cd targeted wins
# (that's the checkout the command operated on), then the hook cwd's branch. Empty if none.
linear_ref_for_cmd() {
  local dir ref=""
  dir=$(_ln_cmd_cd_dir "$1")
  [ -n "$dir" ] && [ -d "$dir" ] && ref=$(linear_issue_ref "$dir")
  [ -n "$ref" ] || ref=$(linear_issue_ref)
  printf '%s' "$ref"
}

# True when the command string actually INVOKES the given gh subcommand ($2, e.g.
# "gh pr merge") — at line start or right after a shell operator. A bare substring grep
# matched the phrase inside a quoted --body and flipped CAR-79 to Done off a `gh pr
# create` whose body merely documented `gh pr merge`.
_ln_cmd_invokes() {
  local verb="${2// /[[:space:]]+}"
  printf '%s' "$1" | grep -qE "(^|&&|\|\|?|;|\\\$\()[[:space:]]*${verb}([[:space:]]|\$)"
}

# PR selector (number or URL) from the args after `gh pr merge`, bounded at the next shell
# operator. Never scan the whole command — a worktree path like .claude/worktrees/CAR-78-x
# earlier in a compound command yields a bogus "78".
_ln_merge_selector() {
  printf '%s' "$1" | sed -nE 's/.*gh pr merge//p' | sed -E 's/[&|;].*//' \
    | grep -oE 'https://github\.com/[^[:space:]]+/pull/[0-9]+|[0-9]+' | head -1
}

# Forward-only rank for downgrade protection. Unknown/terminal (Canceled/Duplicate) => -1.
linear_rank() {
  case "$1" in
    Backlog) echo 0 ;;
    Todo) echo 1 ;;
    "In Progress") echo 2 ;;
    "In Review") echo 3 ;;
    Done) echo 4 ;;
    *) echo -1 ;;
  esac
}

# Low-level GraphQL POST. $1=query $2=variables(JSON, default {}). Prints response JSON.
# Returns 1 when the key is missing or curl fails — callers treat that as a silent skip.
linear_gql() {
  [ -n "${LINEAR_API_KEY:-}" ] || { _ln_log "LINEAR_API_KEY unset — skipping Linear sync"; return 1; }
  # NB: ${2:-{}} is a bash trap — the first } closes the expansion and appends a literal }.
  local query="$1" body vars="${2-}"
  [ -n "$vars" ] || vars='{}'
  body=$(jq -n --arg q "$query" --argjson v "$vars" '{query:$q,variables:$v}') || return 1
  curl -sS --max-time 15 -X POST "$LINEAR_API" \
    -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    --data "$body" 2>/dev/null
}

# Resolve CAR-XX -> "uuid<TAB>teamId<TAB>stateName". Returns 1 if not found.
linear_resolve() {
  local ref="$1" num key resp
  num=$(printf '%s' "$ref" | grep -oE '[0-9]+')
  key=$(printf '%s' "$ref" | grep -oE '^[A-Z]+')
  [ -n "$num" ] && [ -n "$key" ] || return 1
  local q='query($num:Float!,$key:String!){issues(filter:{number:{eq:$num},team:{key:{eq:$key}}},first:1){nodes{id team{id} state{name}}}}'
  resp=$(linear_gql "$q" "$(jq -n --argjson num "$num" --arg key "$key" '{num:$num,key:$key}')") || return 1
  printf '%s' "$resp" | jq -e -r '.data.issues.nodes[0] | select(.!=null) | "\(.id)\t\(.team.id)\t\(.state.name)"' 2>/dev/null
}

# Workflow-state UUID by name within a team. $1=teamId $2=stateName
linear_state_id() {
  local q='query($t:String!){team(id:$t){states{nodes{id name}}}}'
  linear_gql "$q" "$(jq -n --arg t "$1" '{t:$t}')" \
    | jq -r --arg n "$2" '.data.team.states.nodes[] | select(.name==$n) | .id' 2>/dev/null | head -1
}

# Move CAR-XX forward to a target state, refusing downgrades. $1=ref $2=targetName
linear_set_state() {
  local ref="$1" target="$2" info uuid team cur cr tr sid
  info=$(linear_resolve "$ref") || { _ln_log "$ref: not found"; return 1; }
  uuid=${info%%$'\t'*}; team=$(printf '%s' "$info" | cut -f2); cur=$(printf '%s' "$info" | cut -f3)
  cr=$(linear_rank "$cur"); tr=$(linear_rank "$target")
  if [ "$cr" -lt 0 ]; then _ln_log "$ref: state '$cur' terminal/unknown — leaving as-is"; return 0; fi
  if [ "$tr" -le "$cr" ]; then _ln_log "$ref: already '$cur' (>= $target) — no downgrade"; return 0; fi
  sid=$(linear_state_id "$team" "$target"); [ -n "$sid" ] || { _ln_log "$ref: target state '$target' not found"; return 1; }
  local m='mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}'
  if linear_gql "$m" "$(jq -n --arg id "$uuid" --arg s "$sid" '{id:$id,s:$s}')" | jq -e '.data.issueUpdate.success' >/dev/null 2>&1; then
    _ln_log "$ref: $cur -> $target"
  else
    _ln_log "$ref: set-state failed"; return 1
  fi
}

# Idempotent comment upsert keyed by an HTML marker. $1=ref $2=marker $3=body (must contain <!-- marker -->)
linear_upsert_comment() {
  local ref="$1" marker="$2" body="$3" info uuid existing
  info=$(linear_resolve "$ref") || { _ln_log "$ref: not found"; return 1; }
  uuid=${info%%$'\t'*}
  local q='query($id:String!){issue(id:$id){comments{nodes{id body}}}}'
  existing=$(linear_gql "$q" "$(jq -n --arg id "$uuid" '{id:$id}')" \
    | jq -r --arg m "<!-- $marker -->" '.data.issue.comments.nodes[] | select(.body|contains($m)) | .id' 2>/dev/null | head -1)
  if [ -n "$existing" ]; then
    local m='mutation($id:String!,$b:String!){commentUpdate(id:$id,input:{body:$b}){success}}'
    linear_gql "$m" "$(jq -n --arg id "$existing" --arg b "$body" '{id:$id,b:$b}')" \
      | jq -e '.data.commentUpdate.success' >/dev/null 2>&1 && _ln_log "$ref: updated [$marker] comment"
  else
    local m='mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}'
    linear_gql "$m" "$(jq -n --arg id "$uuid" --arg b "$body" '{id:$id,b:$b}')" \
      | jq -e '.data.commentCreate.success' >/dev/null 2>&1 && _ln_log "$ref: created [$marker] comment"
  fi
}
