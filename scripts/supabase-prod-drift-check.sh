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

echo "Checking production for schema drift (supabase db diff --linked)..." >&2

errfile="$(mktemp)"
trap 'rm -f "$errfile"' EXIT

# db diff connects to prod to introspect and can hit transient connection
# timeouts; retry a few times before giving up. Capture the exit code (a bare
# `out=$(...)` assignment would swallow it) so a hard failure can't slip past.
attempts=3
out=""
rc=1
for i in $(seq 1 "$attempts"); do
  out="$(supabase db diff --linked --schema public 2>"$errfile")"
  rc=$?
  if [[ $rc -ne 0 ]] || printf '%s' "$out" | grep -q '"_tag":"Error"'; then
    echo "  attempt $i/$attempts: db diff failed (exit $rc), retrying..." >&2
    sleep 3
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
