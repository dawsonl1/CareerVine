#!/usr/bin/env bash
# Production schema-drift tripwire (CAR-142).
#
# Runs `supabase db diff --linked` (public schema) and fails if the linked
# production database contains schema the local migration chain does NOT
# produce: columns/tables/constraints added by hand, or a migration lost in a
# move (rule 12: contact_companies.location lived untracked in prod for months).
#
# The shadow is built from ONLY the migrations production has actually applied
# (CAR-247), so anything `db diff` reports is undocumented prod state BY
# CONSTRUCTION, rather than by trusting the CLI's diff direction.
#
# This file used to claim `db diff --linked` never flags pending migrations, and
# leaned on that as its safety property. Both halves of that were wrong, and
# CAR-247 measured both against production:
#
#   - It DOES flag pending migrations. The output is "statements that turn the
#     local chain into prod", so a pending CREATE shows up as a DROP. The
#     operator was handed DROP CONSTRAINT for the four constraints they were
#     about to ship — precisely when this script is used as intended.
#   - Worse, the pinned 2.109.1 could not see REAL drift either: with prod
#     holding two columns and four CHECK constraints the chain did not produce,
#     it reported "No schema changes found". The tripwire passed unconditionally.
#
# Both are fixed here: the pin moves to a version that actually detects drift
# (see the CLI PIN block), and the shadow is staged at the applied chain so
# pending migrations cannot be mistaken for it.
#
# On drift, the printed DDL is the starting point for a catch-up migration:
# reconcile it into supabase/migrations/ rather than pushing onto an
# inconsistent base (rule 10: never ad-hoc SQL).
#
# FAIL-CLOSED: a tripwire that cannot run must never read as "no drift". Any
# non-zero db diff exit, missing dependency, empty output, or unrecognized
# output shape exits 1 (refuse the push), never 0.
#
# Requires Docker (db diff builds a shadow DB), node (parses the diff JSON), and
# a linked project (`supabase link --project-ref <ref>`). Run directly or via
# supabase-prod-push.sh. Exit codes: 0 = in sync, 1 = drift or unable to check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null 2>&1 || { echo "Error: docker not found in PATH." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Error: Docker is not running. 'supabase db diff' needs it to build a shadow database." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Error: node not found in PATH (needed to parse the db diff output)." >&2; exit 1; }
command -v supabase >/dev/null 2>&1 || { echo "Error: supabase CLI not found in PATH." >&2; exit 1; }

# CLI PIN (CAR-229, CORRECTED by CAR-247).
#
# ⚠ 2.109.1 — the version this was pinned to from CAR-229 until CAR-247 — is
# BLIND to the drift this script exists to catch. Measured 2026-08-07 against
# production, with the two CAR-242 migration files removed from the chain so
# prod genuinely carried two columns and four CHECK constraints the chain did
# not produce:
#
#   2.109.1  -> {"diff":"","dropStatements":[]}  ("No schema changes found")
#   2.111.0  -> the full ALTER TABLE ADD COLUMN / ADD CONSTRAINT / COMMENT set
#
# So the pin was not protecting correctness; it was suppressing it. Under
# 2.109.1 this tripwire passed unconditionally — a green light that meant
# nothing, which is strictly worse than the false positive that started CAR-247.
# Rule 12's original incident (contact_companies.location living untracked in
# prod for months) is exactly what 2.109.1 cannot see.
#
# What CAR-229 actually observed was the OTHER half: 2.110.0 reporting a pending
# migration's own object. That is real, and it is not a version bug — the output
# is "statements that turn the local chain into prod", so a pending CREATE
# legitimately appears as a DROP. 2.109.1 did it too (CAR-242's pending CHECK
# constraints); CAR-229 just happened to test a FUNCTION, the object type
# 2.109.1 is also blind to. Both observations are the same blindness.
#
# The fix for that half is staging the shadow at the APPLIED chain (below), not
# pinning: with pending migrations excluded from the shadow, the diff has
# nothing pending to report, on any version.
#
# A version bump must be re-verified on BOTH properties: it still detects
# prod-extra state (the measurement above), and it still emits the
# {diff, dropStatements} JSON this script parses.
#
# Deliberately INDEPENDENT of the 2.109.1 pin that gen-supabase-types.sh and
# ci.yml use for `gen types`. That one exists so the generated file stays
# byte-identical to the committed one; this one exists so the diff can see. They
# pin different commands for different reasons and need not move together.
DRIFT_CHECK_CLI_VERSION="2.111.0"
if supabase --version 2>/dev/null | grep -q "$DRIFT_CHECK_CLI_VERSION"; then
  SUPABASE_DIFF_CLI=(supabase)
else
  command -v npx >/dev/null 2>&1 || {
    echo "Error: supabase CLI on PATH is $(supabase --version 2>/dev/null || echo unknown), but this check is only valid on $DRIFT_CHECK_CLI_VERSION, and npx is not available to fetch it (fail-closed)." >&2
    exit 1
  }
  echo "Note: pinning db diff to supabase@$DRIFT_CHECK_CLI_VERSION via npx (PATH has $(supabase --version 2>/dev/null || echo unknown))." >&2
  SUPABASE_DIFF_CLI=(npx -y "supabase@$DRIFT_CHECK_CLI_VERSION")
fi

# Shadow-port pre-check (CAR-171): db diff provisions its shadow database on
# db.shadow_port from supabase/config.toml. A local `supabase start` stack
# holds that port, and the resulting provisioning failure used to surface as a
# misleading "prod connection / link / CLI issue" after three pointless
# retries. The conflict is deterministic, so detect it up front and name the
# fix. DRIFT_CHECK_SHADOW_PORT is a test hook; real runs read config.toml.
shadow_port="${DRIFT_CHECK_SHADOW_PORT:-$(sed -n 's/^shadow_port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' supabase/config.toml | head -n1)}"
shadow_port="${shadow_port:-54320}"
project_id="$(sed -n 's/^project_id[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' supabase/config.toml | head -n1)"

shadow_port_help() {
  echo "The usual cause is a local 'supabase start' stack holding shadow port $shadow_port; the drift check cannot run without it (fail-closed)." >&2
  echo "Fix: run 'supabase stop${project_id:+ --project-id $project_id}', or change db.shadow_port in supabase/config.toml." >&2
  exit 1
}

if (exec 3<>"/dev/tcp/127.0.0.1/$shadow_port") 2>/dev/null; then
  echo "Error: shadow database port $shadow_port is already in use, so 'supabase db diff' cannot provision its shadow database." >&2
  shadow_port_help
fi

# ── Stage the shadow at the APPLIED chain (CAR-247) ──────────────────────────
#
# `db diff --linked` builds its shadow from supabase/migrations/*, i.e. the FULL
# local chain including migrations prod has not applied yet, and reports the
# statements that would turn that chain into prod. A pending migration is a real
# difference by that definition, so it is reported — correctly, but as something
# this script would otherwise announce as "prod drift" and tell the operator to
# undo. On a working CLI that is guaranteed, not incidental.
#
# So remove the ambiguity at the source: hide pending migrations from the
# shadow. `migration list --linked` names which versions prod has; anything
# local-only is staged out into a temp workdir copy, leaving a shadow that is
# exactly what prod SHOULD look like right now. Any difference against that
# shadow can only be undocumented prod state.
#
# This also means the check no longer depends on which direction the CLI reports
# in, only on its ability to see a difference at all.
#
# DRIFT_CHECK_SKIP_STAGING=1 is a test hook for the pre-CAR-247 in-place path.

DIFF_WORKDIR_ARGS=()
staged_tmp=""
cleanup() { [[ -n "$staged_tmp" ]] && rm -rf "$staged_tmp"; rm -f "${errfile:-}"; }
trap cleanup EXIT

if [[ "${DRIFT_CHECK_SKIP_STAGING:-}" != "1" ]]; then
  echo "Resolving which migrations production has applied..." >&2
  mig_err="$(mktemp)"
  mig_out="$("${SUPABASE_DIFF_CLI[@]}" migration list --linked 2>"$mig_err")"
  mig_rc=$?
  if [[ $mig_rc -ne 0 ]] || ! printf '%s' "$mig_out" | grep -q '"migrations"'; then
    echo "Error: could not list applied migrations (exit $mig_rc), so the shadow cannot be staged." >&2
    echo "Refusing to proceed: a drift check that cannot establish what prod has applied must not read as 'no drift'." >&2
    echo "--- stderr ---" >&2; cat "$mig_err" >&2
    echo "--- stdout ---" >&2; printf '%s\n' "$mig_out" >&2
    rm -f "$mig_err"
    exit 1
  fi
  rm -f "$mig_err"

  # PENDING = local file, not on prod (stage out).
  # ORPHAN  = on prod, no local file. That is real, serious drift the old
  #           whole-chain diff could not distinguish, so it fails loudly here.
  pending="$(printf '%s' "$mig_out" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { console.error("unparseable migration list"); process.exit(3); }
      const rows = Array.isArray(j.migrations) ? j.migrations : null;
      if (!rows) { console.error("unexpected migration list shape"); process.exit(3); }
      const has = (v) => typeof v === "string" && v.trim() !== "";
      const orphans = rows.filter((r) => !has(r.local) && has(r.remote)).map((r) => r.remote);
      if (orphans.length) { console.error("ORPHAN " + orphans.join(",")); process.exit(4); }
      console.log(rows.filter((r) => has(r.local) && !has(r.remote)).map((r) => r.local).join("\n"));
    });
  ' 2>&1)"
  pending_rc=$?

  if [[ $pending_rc -eq 4 ]]; then
    echo "" >&2
    echo "PRODUCTION SCHEMA DRIFT DETECTED: prod has applied migrations with no local file." >&2
    echo "----------------------------------------------------------------------" >&2
    printf '%s\n' "${pending#ORPHAN }" | tr ',' '\n' >&2
    echo "----------------------------------------------------------------------" >&2
    echo "A migration file was lost in a move or never committed (rule 12). Restore it before pushing." >&2
    exit 1
  fi
  if [[ $pending_rc -ne 0 ]]; then
    echo "Error: could not parse the migration list; refusing to proceed (fail-closed)." >&2
    printf '%s\n' "$pending" >&2
    exit 1
  fi

  pending_count="$(printf '%s' "$pending" | grep -c . || true)"
  if [[ "$pending_count" -gt 0 ]]; then
    echo "Staging shadow without $pending_count pending migration(s) so they are not misread as prod drift:" >&2
    printf '%s\n' "$pending" | sed 's/^/  - /' >&2

    staged_tmp="$(mktemp -d)"
    # Copy the WHOLE supabase/ dir, then swap in a filtered migrations/. Copying
    # only config.toml + .temp is not enough: config.toml references sibling
    # files (auth email templates, functions), and the CLI fails to load a config
    # whose referenced paths are missing from the workdir. `.` so dotfiles come
    # too — .temp/ is where --linked reads the project ref.
    mkdir -p "$staged_tmp/supabase"
    cp -R supabase/. "$staged_tmp/supabase/"
    rm -rf "$staged_tmp/supabase/migrations"
    mkdir -p "$staged_tmp/supabase/migrations"
    for f in supabase/migrations/*.sql; do
      [[ -e "$f" ]] || continue
      version="$(basename "$f" | sed 's/_.*//')"
      if ! printf '%s\n' "$pending" | grep -qx "$version"; then
        cp "$f" "$staged_tmp/supabase/migrations/"
      fi
    done
    DIFF_WORKDIR_ARGS=(--workdir "$staged_tmp")
  fi
fi

echo "Checking production for schema drift (supabase db diff --linked)..." >&2

errfile="$(mktemp)"

# db diff connects to prod to introspect and can hit transient connection
# timeouts; retry a few times before giving up. Capture the exit code (a bare
# `out=$(...)` assignment would swallow it) so a hard failure can't slip past.
# DRIFT_CHECK_RETRY_DELAY is a test hook; real runs wait 3s between attempts.
retry_delay="${DRIFT_CHECK_RETRY_DELAY:-3}"
attempts=3
out=""
rc=1
for i in $(seq 1 "$attempts"); do
  # ${arr[@]+"${arr[@]}"}, not "${arr[@]}": under `set -u`, bash 3.2 (what macOS
  # ships) treats expanding an EMPTY array as an unbound variable and aborts.
  out="$("${SUPABASE_DIFF_CLI[@]}" ${DIFF_WORKDIR_ARGS[@]+"${DIFF_WORKDIR_ARGS[@]}"} db diff --linked --schema public 2>"$errfile")"
  rc=$?
  # A shadow-provisioning failure (port grabbed after the pre-check above, or
  # any other shadow setup error) is deterministic — retrying just adds noise.
  if printf '%s\n' "$out" | cat - "$errfile" | grep -qE 'LegacyDeclarativeShadowDbError|failed to provision the shadow database'; then
    echo "--- db diff stderr ---" >&2; cat "$errfile" >&2
    echo "Error: 'supabase db diff' failed to provision its shadow database (see stderr above)." >&2
    shadow_port_help
  fi
  if [[ $rc -ne 0 ]] || printf '%s' "$out" | grep -q '"_tag":"Error"'; then
    echo "  attempt $i/$attempts: db diff failed (exit $rc), retrying..." >&2
    sleep "$retry_delay"
    continue
  fi
  break
done

if [[ $rc -ne 0 ]] || printf '%s' "$out" | grep -q '"_tag":"Error"'; then
  echo "Error: could not check drift after $attempts attempts (prod connection / link / CLI issue)." >&2
  echo "Refusing to proceed: a drift check that cannot run must not read as 'no drift'." >&2
  echo "--- last stderr ---" >&2; cat "$errfile" >&2
  echo "--- last stdout ---" >&2; printf '%s\n' "$out" >&2
  exit 1
fi

# Parse the JSON verdict. The parser is authoritative about CLEAN vs DRIFT and
# exits non-zero (fail-closed) on empty output or any shape it doesn't
# recognize, so a changed CLI output format can't read as clean.
verdict="$(printf '%s' "$out" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let j;
    try { j = JSON.parse(s); } catch { console.error("unparseable: db diff output is not JSON"); process.exit(3); }
    if (j === null || typeof j !== "object" || !("diff" in j) || !("dropStatements" in j)) {
      console.error("unparseable: unexpected db diff JSON shape"); process.exit(3);
    }
    const diff = String(j.diff || "").trim();
    const drops = Array.isArray(j.dropStatements) ? j.dropStatements : [];
    if (diff || drops.length) {
      console.log("DRIFT");
      if (diff) console.log(diff);
      if (drops.length) console.log(drops.join("\n"));
    } else {
      console.log("CLEAN");
    }
  });
')"
parse_rc=$?

if [[ $parse_rc -ne 0 ]]; then
  echo "Error: could not parse 'supabase db diff' output; refusing to proceed (fail-closed)." >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

if [[ "$(printf '%s' "$verdict" | head -n1)" == "DRIFT" ]]; then
  echo "" >&2
  echo "PRODUCTION SCHEMA DRIFT DETECTED: prod has schema the migration chain does not produce." >&2
  echo "----------------------------------------------------------------------" >&2
  printf '%s\n' "$verdict" | tail -n +2 >&2
  echo "----------------------------------------------------------------------" >&2
  echo "Reconcile this into a catch-up migration under supabase/migrations/ before pushing (rule 10)." >&2
  exit 1
fi

echo "No production schema drift: prod matches the migration chain." >&2
exit 0
