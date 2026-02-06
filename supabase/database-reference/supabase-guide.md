# Supabase Workflow Guide

Everything below assumes you are in the repo root (`Networking-Helper/`).

## 1. Required environment variables

Create `.env.local` (already gitignored) and fill in these values from the Supabase dashboard (Settings → Project Settings → API):

```env
# Remote / production Supabase project
NEXT_PUBLIC_SUPABASE_URL=...        # Project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...   # Publishable key
SUPABASE_SERVICE_ROLE_KEY=...       # Secret/service role key (server only)
SUPABASE_DB_PASSWORD=...            # Postgres password you chose when creating the project

# Local Supabase stack (used automatically when NODE_ENV=development and values exist)
NEXT_PUBLIC_SUPABASE_URL_LOCAL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY_LOCAL=sb_secret_...
SUPABASE_DB_URL_LOCAL=postgresql://postgres:postgres@127.0.0.1:54322/postgres  # For direct DB connections
```

Keep `.env.example` updated so teammates know which vars to set.

## 2. CLI setup & project linking

```bash
brew install supabase/tap/supabase   # installed already
supabase login                      # opens browser for token
supabase link --project-ref <project-id>
```

`<project-id>` is shown in the Supabase dashboard under Project Settings → General (e.g., `iycrlwqjetkwaauzxrhd`). 

**Important**: Linking stores credentials so the CLI knows which remote project to target. However, when working locally, the CLI will still check the remote database first (this is a safety feature).

## 3. Local development database

1. Start the local Supabase stack (runs Docker containers + applies all migrations):

```bash
supabase start
```

The CLI prints local URLs, auth keys, and the Postgres connection string.

2. Stop it when you're done:

```bash
supabase stop
```

### Local-First Migration Workflow

**For testing migrations locally before remote deployment:**

1. **Create new migration** (see section 5 below)
2. **Apply to local database only**:
   ```bash
   supabase migration up
   ```
3. **Test your changes** with the Next.js app
4. **Once verified**, push to production (see section 4)

**Note**: `supabase migration up` is designed specifically for local development and does not check or modify the remote database.

### Alternative local commands

- Use the helper script:
  ```bash
  ./scripts/supabase-dev-push.sh
  ```

- To rebuild the local DB from scratch (destroys data):
  ```bash
  supabase db reset
  ```

## 4. Production migrations

**Only after testing locally:**

Use the production helper script (targets the linked remote project):

```bash
./scripts/supabase-prod-push.sh
```

This runs `supabase db push` without extra flags, so it applies all pending migrations in `supabase/migrations/` to the hosted project. **Double-check migrations before running this command.**

## 5. Creating new migrations

1. Update `database-reference/v0.dbml` (or the SQL reference) if you need to visualize changes.

2. Generate a new migration file:

```bash
supabase migration new <description>
```

This creates `supabase/migrations/<timestamp>_<description>.sql`.

3. Edit the SQL to include your schema changes.

4. **Test locally first**:
   ```bash
   supabase migration up
   ```

5. Test your app with the local changes.

6. **Once verified**, run `./scripts/supabase-prod-push.sh` to update production.

## 6. Auth & security notes

- `public.users.id` references `auth.users(id)` so every signup should create a matching profile row (via API route/Edge Function).
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only; frontend uses the publishable key.
- Enable Row Level Security on tables and write policies (e.g., `auth.uid() = contacts.user_id`) so anon key usage remains safe.

## 7. Troubleshooting tips

- `supabase status` shows local stack status and URLs
- Connect directly to local DB: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres"`
- If `supabase start` fails because of stale containers, try `supabase stop` then `supabase start --reset`.
- `WARN: no files matched pattern: supabase/seed.sql` just means you don't have a seed file yet; safe to ignore.
- Use `supabase migration up` for local development (no remote database interaction)
- Use `supabase db push` for production deployment (requires confirmation)

## 8. Recommended Development Workflow

1. `supabase start` - Start local stack
2. Make schema changes → `supabase migration new <description>`
3. Edit migration file
4. `supabase migration up` - Test locally
5. Test app functionality
6. Once satisfied: `./scripts/supabase-prod-push.sh`
7. `supabase stop` when done

Refer back to this guide whenever you forget the command flow.
