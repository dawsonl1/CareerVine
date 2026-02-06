#!/usr/bin/env bash
set -euo pipefail

# Applies pending migrations to the remote Supabase project.
# WARNING: This affects production! Only run after testing locally.
# Usage: ./scripts/supabase-prod-push.sh

# Check if we're in a Supabase project
if [[ ! -f "supabase/config.toml" ]] && ! supabase status > /dev/null 2>&1; then
  echo "Error: No Supabase project detected. Run 'supabase link <project-ref>' first." >&2
  exit 1
fi

echo "WARNING: This will apply migrations to the REMOTE Supabase project."
echo "Make sure you've tested locally with 'supabase db push --local' first."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled."
  exit 0
fi

echo "Pushing migrations to remote Supabase project..."
supabase db push

echo "Done. Remote database updated."
