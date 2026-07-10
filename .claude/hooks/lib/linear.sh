#!/usr/bin/env bash
# Shared helpers for CareerVine's worktree → Linear → PR lifecycle hooks (CAR-33).
# Deterministic status flips + idempotent comment upserts against Linear's GraphQL API.
#
# Design contract: every function is a QUIET NO-OP (returns 0) when LINEAR_API_KEY is
# unset, so a hook can never block or slow a git action. Diagnostics go to stderr only.

LINEAR_API="https://api.linear.app/graphql"

_ln_log() { printf '[linear-hook] %s\n' "$*" >&2; }

# Pure parser: extract CAR-XX from any string (branch, filename), upcased. Empty if none.
# Exposed (underscore-prefixed) so tests can exercise it without a repo/API.
_ln_parse_ref() { printf '%s' "$1" | grep -oiE 'car-[0-9]+' | head -1 | tr '[:lower:]' '[:upper:]'; }

# CAR-XX from the current git branch.
linear_issue_ref() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || return 0
  _ln_parse_ref "$branch"
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
