-- CAR-243: backfill companies to Active outreach where a contact already replied.
--
-- CAR-239 added the automation that moves a company Researching -> Active
-- outreach once someone there writes back. It fired almost never, for two
-- reasons fixed in the same PR as this migration:
--
--   * it was called only from syncThreadReplies, but /api/gmail/sync runs
--     syncAllContactEmails FIRST and that path ingests virtually every reply,
--     so the sweep only ever saw duplicates and an empty replied-thread set;
--   * it advanced every company a contact had ever worked at, not the one they
--     work at now.
--
-- Neither fix is retroactive, so this migration closes the accumulated gap.
-- Measured on production 2026-08-06: 12 contacts had a real email reply, and
-- exactly ONE of their current employers (Brevium) sat at Active outreach.
--
-- Derived from the data at apply time rather than from a hardcoded id list, so
-- it is correct for every user, not just the one whose gap was measured. The
-- reply rule below mirrors getContactStages exactly
-- (careervine/src/lib/company-queries.ts, the outboundAt/inboundAt aggregation):
-- a non-simulated INBOUND message whose from_address is one of the contact's
-- OWN addresses, dated on or after our earliest outbound to them. The sender
-- gate is what stops a reply-all on a shared thread from crediting every cc'd
-- co-recipient; the date gate is what stops a pre-existing conversation from
-- reading as a reply to outreach that had not happened yet.
--
-- FORWARD ONLY, matching invariant 1 of the automation: only 'researching' rows
-- move. A company already at applied/interviewing/closed is left alone, because
-- dragging a live application backwards would be worse than the staleness.
--
-- Idempotent: a re-run finds no 'researching' rows left in the derived set and
-- updates nothing.

BEGIN;

CREATE TEMP TABLE car243_replied_targets ON COMMIT DROP AS
WITH first_outbound AS (
  -- Earliest outbound we sent each contact. Credits every linked contact on the
  -- message: they all received the outreach.
  SELECT emc.contact_id, MIN(em.date) AS sent_at
  FROM email_message_contacts emc
  JOIN email_messages em ON em.id = emc.email_message_id
  WHERE em.direction = 'outbound'
    AND em.is_simulated = false
  GROUP BY emc.contact_id
),
replied AS (
  -- Contacts who actually wrote back, with the user who owns the mailbox.
  SELECT DISTINCT em.user_id, emc.contact_id
  FROM email_message_contacts emc
  JOIN email_messages em ON em.id = emc.email_message_id
  JOIN first_outbound fo ON fo.contact_id = emc.contact_id
  JOIN contact_emails ce
    ON ce.contact_id = emc.contact_id
   -- contact_emails.email is stored already lower(trim())'d; from_address is not.
   AND ce.email = lower(trim(em.from_address))
  WHERE em.direction = 'inbound'
    AND em.is_simulated = false
    AND em.date >= fo.sent_at
)
SELECT DISTINCT tc.id AS target_id, tc.active_cycle
FROM replied r
JOIN contacts c
  ON c.id = r.contact_id
 -- Both sides of the join must belong to the same user. `replied` carries the
 -- mailbox owner and `contacts` the record owner; on a correctly-linked row they
 -- are the same, and requiring it keeps a cross-tenant link from advancing
 -- somebody else's pipeline.
 AND c.user_id = r.user_id
JOIN contact_companies cc
  ON cc.contact_id = c.id
 -- CURRENT employer only. A reply says where the person works now; it says
 -- nothing about a company they left years ago.
 AND cc.is_current = true
JOIN target_companies tc
  ON tc.company_id = cc.company_id
 AND tc.user_id = c.user_id
WHERE tc.status = 'researching';

UPDATE target_companies tc
SET status = 'outreach_active',
    updated_at = now()
FROM car243_replied_targets t
WHERE tc.id = t.target_id
  -- Re-asserted so this is a no-op on re-run and cannot clobber a row that
  -- moved further along between the SELECT above and here.
  AND tc.status = 'researching';

-- Mirror onto the active cycle, because the company page reads the cycle while
-- the companies list reads the target row. Most affected rows have NO cycle row
-- at all (the page then seeds its stage from target_companies.status via
-- cycleHintsFromTarget), so this updates few or none — it exists so the two
-- surfaces cannot disagree where a cycle row does exist.
UPDATE pipeline_cycles pc
SET selected_stage = 'outreach_active'
FROM car243_replied_targets t
WHERE pc.target_company_id = t.target_id
  AND pc.cycle_number = GREATEST(t.active_cycle, 1)
  AND pc.selected_stage = 'researching';

DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM car243_replied_targets;
  RAISE NOTICE 'CAR-243 backfill: % target_companies rows matched (replied contact at their current employer, still on researching)', n;
END $$;

COMMIT;
