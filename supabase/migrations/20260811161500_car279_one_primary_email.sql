-- CAR-279: exactly one primary email per contact, enforced by the database.
--
-- `contact_emails.is_primary` is what the product actually sends to:
-- resolveRecipient (mcp/lib/email-policy.ts), the outreach queue
-- (lib/company-queries.ts), the profile card, and the AI follow-up generator,
-- which queries `.eq("is_primary", true)` with NO fallback and silently skips a
-- contact that has none. Nothing enforced the flag, and six call sites write
-- this table directly, so both failure modes were reachable:
--
--   * zero primaries -- the web UI's "delete every row, re-insert from client
--     state" save, where is_primary was only ever set for the first row, so
--     removing the primary left addresses with no primary at all;
--   * two primaries -- any writer inserting is_primary = true without demoting.
--
-- Enforcement is here rather than in the data layer because the invariant has to
-- hold for writers that do not share one: the extension import route, bulk
-- import, bundle fast-apply, the Apify merge, admin, MCP and three UI surfaces.
--
-- Ordering below is load-bearing: backfill first (the index would reject
-- today's data), then the index, then the triggers.

-- ── 1. Survivor ranking ────────────────────────────────────────────────
--
-- Used by the backfill and by the promote trigger to answer one question: with
-- the primary gone, which address takes over? Prefer a row that HAS an address,
-- then one that has not bounced, then provenance, then the most recently added.
--
-- The source ranking mirrors EMAIL_SOURCE_RANK in lib/scrape-merge.ts (with
-- 'manual' added, which that map omits because the merge path treats manual as
-- untouchable rather than ranked). It breaks TIES among survivors and never
-- overrides an explicit choice: every writer that means a specific row sets
-- is_primary on it directly, and this function is not consulted.
--
-- `SET search_path` on all three functions below is load-bearing, not
-- boilerplate. These fire on DELETE, and one of the roles that deletes
-- contact_emails rows is GoTrue's: removing an auth user cascades
-- auth.users -> users -> contacts -> contact_emails. Its session does not carry
-- `public` on the search path, so an unqualified reference raised
-- `relation "contact_emails" does not exist` (42P01) and the whole user
-- deletion failed with a 500. The existing CAR-172 trigger on this table gets
-- away without it only because it never fires on DELETE.
CREATE OR REPLACE FUNCTION best_primary_contact_email(p_contact_id int)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT id
    FROM contact_emails
   WHERE contact_id = p_contact_id
   ORDER BY (email IS NOT NULL) DESC,
            (bounced_at IS NULL) DESC,
            CASE source
              WHEN 'verified' THEN 4
              WHEN 'manual' THEN 3
              WHEN 'scraped' THEN 2
              WHEN 'pattern_guessed' THEN 1
              ELSE 0
            END DESC,
            id DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION best_primary_contact_email(int) IS
  'CAR-279: which of a contact''s addresses should hold is_primary when the current one disappears. Live address first, then provenance, then newest.';

-- ── 2. Backfill ────────────────────────────────────────────────────────

-- 2a. More than one primary: keep the best-ranked, demote the rest.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY contact_id
           ORDER BY (email IS NOT NULL) DESC,
                    (bounced_at IS NULL) DESC,
                    CASE source
                      WHEN 'verified' THEN 4
                      WHEN 'manual' THEN 3
                      WHEN 'scraped' THEN 2
                      WHEN 'pattern_guessed' THEN 1
                      ELSE 0
                    END DESC,
                    id DESC
         ) AS rn
    FROM contact_emails
   WHERE is_primary
)
UPDATE contact_emails ce
   SET is_primary = false
  FROM ranked r
 WHERE ce.id = r.id
   AND r.rn > 1;

-- 2b. Addresses but no primary: promote the best-ranked.
WITH no_primary AS (
  SELECT contact_id
    FROM contact_emails
   GROUP BY contact_id
  HAVING bool_or(is_primary) IS NOT TRUE
)
UPDATE contact_emails
   SET is_primary = true
 WHERE id IN (
   SELECT best_primary_contact_email(contact_id) FROM no_primary
 );

-- 2c. Align contacts.preferred_contact_value with the primary address.
--
-- Direction matters. The pair (preferred_contact_method, preferred_contact_value)
-- is write-only today -- nothing reads it but the edit modal rehydrating its own
-- checkbox -- so a stored value disagreeing with is_primary has never affected a
-- send. Aligning the VALUE to the primary therefore changes no recipients.
-- Promoting the stored value to primary instead would silently redirect mail for
-- every contact whose two records disagree, without review. From here on the UI
-- writes both together and the trigger below keeps them that way.
UPDATE contacts c
   SET preferred_contact_value = ce.email
  FROM contact_emails ce
 WHERE ce.contact_id = c.id
   AND ce.is_primary
   AND c.preferred_contact_method = 'email'
   AND c.preferred_contact_value IS DISTINCT FROM ce.email;

-- A contact whose method says 'email' but who has no primary address left is a
-- half-state the UI cannot render; clear both halves together.
UPDATE contacts c
   SET preferred_contact_method = NULL,
       preferred_contact_value = NULL
 WHERE c.preferred_contact_method = 'email'
   AND NOT EXISTS (
     SELECT 1 FROM contact_emails ce
      WHERE ce.contact_id = c.id AND ce.is_primary AND ce.email IS NOT NULL
   );

-- ── 3. At most one primary ─────────────────────────────────────────────
--
-- Partial unique index, so "two primaries" is unrepresentable rather than
-- merely discouraged. It is immediate and non-deferrable (a partial unique
-- index cannot be a deferrable CONSTRAINT), which is what forces the demote
-- trigger below to be BEFORE rather than AFTER.
CREATE UNIQUE INDEX IF NOT EXISTS contact_emails_one_primary_idx
  ON contact_emails (contact_id)
  WHERE is_primary;

COMMENT ON COLUMN contact_emails.is_primary IS
  'The address this contact is reached at. CAR-279: a contact with any rows has exactly one -- contact_emails_one_primary_idx enforces at most one, contact_emails_ensure_primary enforces at least one. Setting it on a row demotes the others automatically; never demote by hand first.';

-- ── 4. Promoting one row demotes the others ────────────────────────────
--
-- BEFORE, not AFTER: the unique index above is checked as each row hits the
-- table, so the demotion has to be already done by then.
--
-- `id IS DISTINCT FROM NEW.id` rather than `<>`: on INSERT the identity default
-- is materialized before BEFORE-row triggers fire, so NEW.id is normally set --
-- but if it ever were not, `id <> NULL` is NULL for every row and the demotion
-- would silently do nothing, which is the exact corruption this prevents.
--
-- No recursion: the nested UPDATE sets is_primary = false, which fails the
-- trigger's WHEN clause.
CREATE OR REPLACE FUNCTION contact_emails_demote_other_primaries()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE contact_emails
     SET is_primary = false
   WHERE contact_id = NEW.contact_id
     AND id IS DISTINCT FROM NEW.id
     AND is_primary;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contact_emails_demote_other_primaries ON contact_emails;
CREATE TRIGGER contact_emails_demote_other_primaries
  BEFORE INSERT OR UPDATE OF is_primary ON contact_emails
  FOR EACH ROW
  WHEN (NEW.is_primary)
  EXECUTE FUNCTION contact_emails_demote_other_primaries();

-- ── 5. Losing the primary promotes a survivor ──────────────────────────
--
-- AFTER, and per row: for a multi-row DELETE the after-row triggers are queued
-- and fire once the whole statement has landed, so a "delete every address"
-- save sees the final empty set and promotes nothing, rather than promoting a
-- row that is about to be deleted.
--
-- Also fires on INSERT so that a first address arriving as non-primary (the
-- Gmail path files a newly discovered reply address that way) still leaves the
-- contact reachable.
--
-- Runs ONLY for top-level statements (`pg_trigger_depth() = 1`), and that guard
-- is load-bearing rather than an optimization. Without it the demote trigger
-- above defeats itself: promoting a new address fires BEFORE INSERT, whose
-- nested UPDATE demotes the incumbent, whose own AFTER trigger then observes a
-- contact with no primary -- the new row does not exist yet, since its INSERT
-- has not landed -- and dutifully re-promotes the row just demoted. The outer
-- INSERT then hits the unique index and the whole write fails with 23505.
-- Nesting only ever comes from this function or its sibling, and both leave the
-- table settled, so there is nothing at depth > 1 worth reacting to.
--
-- Terminates in one hop even at depth 1: the promoting UPDATE re-enters this
-- function, the EXISTS check now succeeds, and nothing further is written.
--
-- Touches ONLY contact_emails, deliberately. The obvious extra job for this
-- trigger -- keeping `contacts.preferred_contact_value` pointing at whichever
-- address is primary -- would make it read and write `contacts`, and one of the
-- roles that deletes from this table is GoTrue's, which has no privilege on
-- `contacts` at all (`permission denied for table contacts`, 42501, on every
-- auth-user deletion). The ways out were SECURITY DEFINER or dropping the
-- cross-table write. Dropping it wins on the merits, not just on effort: it
-- adds no privilege-escalation surface to a table whose isolation is RLS, it
-- spares a `contacts` row lock on every one of the thousands of email rows a
-- bundle apply inserts, and the pair it was protecting is written together by
-- the UI anyway (and read by nothing else -- the edit modal now seeds its
-- checkbox from is_primary). The extension path, the one place that moves the
-- primary without going through that form, realigns it in
-- applyImportedPrimaryEmail.
--
-- SECURITY DEFINER, unlike its sibling above, and for a reason that is not
-- obvious from this function's own body: it reads `contact_emails`, and the RLS
-- policy on that table is written as an EXISTS over `contacts`. Evaluating a
-- policy requires SELECT privilege on every table the policy itself touches, so
-- reading one row here as GoTrue's role fails with
-- `permission denied for table contacts` -- which surfaces as a 500 on deleting
-- an auth user, since that cascades auth.users -> users -> contacts ->
-- contact_emails. The cascade's own DELETE is an RI action and bypasses RLS;
-- this trigger is ordinary SQL and does not.
--
-- The escalation this grants is nil. The only contact_id it can ever see is the
-- one on a row the caller just legitimately wrote or deleted -- RLS vetted THAT
-- statement -- and all it may do with it is move `is_primary` between that same
-- contact's rows. It takes no caller input, builds no dynamic SQL, and its
-- search path is pinned above.
--
-- The demote trigger stays SECURITY INVOKER on purpose: its UPDATE is filtered
-- by the caller's own RLS policy, which is a check worth keeping, and it never
-- runs under a role that lacks the rights to evaluate it.
CREATE OR REPLACE FUNCTION contact_emails_ensure_primary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contact_id int;
  v_promote_id int;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  v_contact_id := CASE TG_OP WHEN 'DELETE' THEN OLD.contact_id ELSE NEW.contact_id END;

  IF NOT EXISTS (
    SELECT 1 FROM contact_emails WHERE contact_id = v_contact_id AND is_primary
  ) THEN
    -- NULL when the contact has no addresses left at all, which is also what a
    -- cascading delete of the whole contact looks like from here: the after-row
    -- triggers fire once the statement has finished, so every row is already
    -- gone and there is nothing to promote.
    v_promote_id := best_primary_contact_email(v_contact_id);
    IF v_promote_id IS NOT NULL THEN
      UPDATE contact_emails SET is_primary = true WHERE id = v_promote_id;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

-- Nobody CALLS a trigger function; firing a trigger does not consult the
-- invoker's EXECUTE privilege, which is checked once, against the creator, when
-- the trigger is defined. Supabase's ALTER DEFAULT PRIVILEGES hands every new
-- public function to anon and authenticated, so a SECURITY DEFINER one has to
-- be taken back explicitly (grant-lockdowns.itest.ts fails the build otherwise,
-- CAR-220/CAR-181). REVOKE ... FROM PUBLIC does not cover these two: the grant
-- is to the roles by name.
-- All three: PUBLIC alone leaves the two named grants in place, and naming the
-- two alone leaves EXECUTE reachable through PUBLIC, which every role holds.
REVOKE EXECUTE ON FUNCTION contact_emails_ensure_primary() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contact_emails_ensure_primary ON contact_emails;
CREATE TRIGGER contact_emails_ensure_primary
  AFTER INSERT OR DELETE OR UPDATE OF is_primary ON contact_emails
  FOR EACH ROW
  EXECUTE FUNCTION contact_emails_ensure_primary();
