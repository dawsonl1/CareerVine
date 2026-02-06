#!/usr/bin/env bash
set -euo pipefail

# Applies pending migrations to the linked Supabase project (production).
# Usage: ./scripts/supabase-prod-push.sh

supabase db push
