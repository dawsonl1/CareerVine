#!/usr/bin/env bash
# Production schema-drift tripwire (CAR-142).
#
# Runs `supabase db diff --linked` (public schema) and fails if the linked
# production database contains schema the local migration chain does NOT
# produce: columns/tables/constraints added by hand, or a migration lost in a
# move (rule 12: contact_companies.location lived untracked in prod for months).
#
# `db diff --linked` reports only *undocumented prod state* and does NOT flag
# pending migrations (schema in local files but not yet on prod, verified
# empirically), so it is safe to run as a pre-flight right before a push.
#
# On drift, the printed DDL is the starting point for a catch-up migration:
# reconcile it into supabase/migrations/ rather than pushing onto an
# inconsistent base (rule 10: never ad-hoc SQL).
#
# Requires Docker (db diff builds a shadow DB) and a linked project
# (`supabase link --project-ref <ref>`). Run directly or via supabase-prod-push.sh.
# Exit codes: 0 = in sync, 1 = drift or unable to check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running. 'supabase db diff' needs it to build a shadow database." >&2
  exit 1
fi

echo "Checking production for schema drift (supabase db diff --linked)..." >&2

# db diff connects to prod to introspect and can hit transient connection
# timeouts; retry a few times before giving up.
attempts=3
out=""
for i in $(seq 1 "$attempts"); do
  out="$(supabase db diff --linked --schema public 2>/dev/null)"
  if printf '%s' "$out" | grep -q '"_tag":"Error"'; then
    echo "  attempt $i/$attempts: transient error from db diff, retrying..." >&2
    sleep 3
    continue
  fi
  break
done

if printf '%s' "$out" | grep -q '"_tag":"Error"'; then
  echo "Error: could not check drift after $attempts attempts (prod connection or link issue):" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

# The CLI emits JSON: { diff, dropStatements, ... }. Extract the meaningful diff;
# fall back to treating raw stdout as DDL if the format ever changes.
drift="$(printf '%s' "$out" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const j = JSON.parse(s);
      const diff = String(j.diff || "").trim();
      const drops = Array.isArray(j.dropStatements) ? j.dropStatements : [];
      if (diff) console.log(diff);
      if (drops.length) console.log(drops.join("\n"));
    } catch {
      console.log(s.trim());
    }
  });
')"

if [[ -n "$drift" ]]; then
  echo "" >&2
  echo "PRODUCTION SCHEMA DRIFT DETECTED: prod has schema the migration chain does not produce." >&2
  echo "----------------------------------------------------------------------" >&2
  printf '%s\n' "$drift" >&2
  echo "----------------------------------------------------------------------" >&2
  echo "Reconcile this into a catch-up migration under supabase/migrations/ before pushing (rule 10)." >&2
  exit 1
fi

echo "No production schema drift: prod matches the migration chain." >&2
exit 0
