#!/usr/bin/env bash
set -euo pipefail

# Applies pending migrations to the local Supabase stack that was started via `supabase start`.
# Usage: ./scripts/supabase-dev-push.sh

# Check if local Supabase is running
if ! supabase status > /dev/null 2>&1; then
  echo "No local Supabase instance detected. Run 'supabase start' first." >&2
  exit 1
fi

echo "Applying migrations to LOCAL database only..."

# Apply migrations to local database using migration up (local-only)
supabase migration up

echo "Local database updated successfully."