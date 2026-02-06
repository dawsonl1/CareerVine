#!/usr/bin/env bash
set -euo pipefail

# Applies pending migrations to the local Supabase stack that was started via `supabase start`.
# Usage: ./scripts/supabase-dev-push.sh

db_url=$(supabase status --db-url)

if [[ -z "$db_url" ]]; then
  echo "No local Supabase instance detected. Run 'supabase start' first." >&2
  exit 1
fi

supabase db push --db-url "$db_url"
