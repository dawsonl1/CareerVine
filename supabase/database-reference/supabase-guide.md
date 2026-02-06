# Supabase Workflow Guide

Everything below assumes you are in the repo root (`Networking-Helper/`).

## 1. Required environment variables

Create `.env.local` (already gitignored) and fill in these values from the Supabase dashboard (Settings → Project Settings → API):

```env
NEXT_PUBLIC_SUPABASE_URL=...        # Project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=...   # Publishable key
SUPABASE_SERVICE_ROLE_KEY=...       # Secret/service role key (server only)
SUPABASE_DB_PASSWORD=...            # Postgres password you chose when creating the project

# Optional local stack overrides (used automatically when NODE_ENV=development and values exist)
NEXT_PUBLIC_SUPABASE_URL_LOCAL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY_LOCAL=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY_LOCAL=sb_secret_...
```

Keep `.env.example` updated so teammates know which vars to set.


## 2. CLI setup & project linking

```bash
brew install supabase/tap/supabase   # installed already
supabase login                      # opens browser for token
supabase link --project-ref <project-id>
```

`<project-id>` is shown in the Supabase dashboard under Project Settings → General (e.g., `iycrlwqjetkwaauzxrhd`). Linking stores credentials in `supabase/.supabase/config.toml` so commands know which remote project to target.

## 3. Local development database

1. Start the local Supabase stack (runs Docker containers + applies all migrations):

```bash
supabase start
```

The CLI prints local URLs, auth keys, and the Postgres connection string.

2. Stop it when you’re done:

```bash
supabase stop
```

### Applying migrations locally

- Use the helper script (wraps `supabase db push --db-url ...`):

```bash
./scripts/supabase-dev-push.sh
```

Requires `supabase start` to be running; keeps existing local data.

- To rebuild the local DB from scratch (destroys data):

```bash
supabase db reset
```

## 4. Production migrations

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
4. Apply locally (`./scripts/supabase-dev-push.sh` or `supabase db reset`).
5. Once verified, run `./scripts/supabase-prod-push.sh` to update production.

## 6. Auth & security notes

- `public.users.id` references `auth.users(id)` so every signup should create a matching profile row (via API route/Edge Function).
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only; frontend uses the publishable key.
- Enable Row Level Security on tables and write policies (e.g., `auth.uid() = contacts.user_id`) so anon key usage remains safe.

## 7. Troubleshooting tips

- `supabase status --db-url` returns the connection string for the running local stack. Helpful if you need to connect with Prisma or psql.
- If `supabase start` fails because of stale containers, try `supabase stop` then `supabase start --reset`.
- `WARN: no files matched pattern: supabase/seed.sql` just means you don’t have a seed file yet; safe to ignore.

Refer back to this guide whenever you forget the command flow.
