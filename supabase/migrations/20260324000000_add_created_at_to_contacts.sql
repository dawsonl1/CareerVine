-- Add created_at column to contacts table
-- Existing contacts get current timestamp as default (we don't know when they were actually created)
-- New contacts will automatically get now() on insert
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
