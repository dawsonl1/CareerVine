#!/usr/bin/env bash
# Production schema-drift tripwire (CAR-142).
#
# Runs `supabase db diff --linked` (public schema) and fails if the linked
# production database contains schema the local migration chain does NOT
# produce: columns/tables/constraints added by hand, or a migration lost in a
# move (rule 12: contact_companies.location lived untracked in prod for months).
#
# `db diff --linked` reports only *undocumented prod state* and does NOT flag
# pending migrations (schema in local files but not yet on prod). That direction
# is what makes this safe to run as a pre-flight right before a push; it was
# verified empirically on supabase CLI 2.109.1 and is version-dependent, so a
# CLI whose `db diff` output shape or direction changed will fail CLOSED here
# (see below) rather than silently pass.
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

# CLI PIN (CAR-229). The header's central claim — that `db diff --linked`
# reports only undocumented PROD state and never flags a pending migration — is
# a property of the CLI version, not of the command. It holds on 2.109.1 and
# BROKE on 2.110.0, which emits a `DROP FUNCTION ...` for a migration that
# exists locally and has not been pushed yet.
#
# That failure mode is maximally misleading, because it fires precisely when
# this script is used as intended: as the preflight immediately before pushing a
# new migration. The operator is told "PRODUCTION SCHEMA DRIFT DETECTED" and
# handed a DROP for the very object they are about to create.
#
# Verified empirically on 2026-08-05 from a worktree carrying exactly one
# unpushed migration: 2.109.1 -> {"diff":"","dropStatements":[]} ("No schema
# changes found"); 2.110.0 -> a DROP for that migration's new function. Prod was
# confirmed independently (pg_proc + supabase_migrations.schema_migrations) to
# NOT contain the object, so 2.109.1 was right and 2.110.0's output inverts the
# direction this script depends on.
#
# So: pin the diff to the verified version rather than trusting PATH. Matches
# the existing pin in .github/workflows/ci.yml for `gen types`. A version bump
# here must be re-verified against the pending-migration case above.
DRIFT_CHECK_CLI_VERSION="2.109.1"
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

echo "Checking production for schema drift (supabase db diff --linked)..." >&2

errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT

# db diff connects to prod to introspect and can hit transient connection
# timeouts; retry a few times before giving up. Capture the exit code (a bare
# `out=$(...)` assignment would swallow it) so a hard failure can't slip past.
# DRIFT_CHECK_RETRY_DELAY is a test hook; real runs wait 3s between attempts.
retry_delay="${DRIFT_CHECK_RETRY_DELAY:-3}"
attempts=3
out=""
rc=1
for i in $(seq 1 "$attempts"); do
  out="$("${SUPABASE_DIFF_CLI[@]}" db diff --linked --schema public 2>"$errfile")"
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
