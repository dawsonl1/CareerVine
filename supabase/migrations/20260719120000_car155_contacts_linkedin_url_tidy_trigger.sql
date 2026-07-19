-- CAR-155: belt-and-suspenders for the linkedin_url dedupe invariant.
--
-- The application-side chokepoint (createContact/updateContact in
-- careervine/src/lib/data/contacts.ts) canonicalizes every linkedin_url via
-- canonicalizeLinkedinUrl. Reimplementing that full canonicalization in SQL
-- would create a second rule implementation that could drift — the exact
-- anti-pattern CAR-155 retires — so this trigger applies only the cheap
-- tidy transform: trim whitespace, strip trailing slashes, collapse empty
-- to NULL. It is a strict no-op for canonical LinkedIn values, and for
-- non-LinkedIn strings it matches the chokepoint's own fallback
-- (canonicalizeContactPayload applies the same trim + trailing-slash strip),
-- so app-computed and stored values never diverge. Out-of-band SQL (psql,
-- future scripts) can no longer introduce the most common
-- formatting-variant duplicates.

CREATE OR REPLACE FUNCTION public.tidy_contact_linkedin_url()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.linkedin_url IS NOT NULL THEN
    NEW.linkedin_url := regexp_replace(btrim(NEW.linkedin_url), '/+$', '');
    IF NEW.linkedin_url = '' THEN
      NEW.linkedin_url := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contacts_tidy_linkedin_url ON public.contacts;
CREATE TRIGGER contacts_tidy_linkedin_url
  BEFORE INSERT OR UPDATE OF linkedin_url ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.tidy_contact_linkedin_url();
