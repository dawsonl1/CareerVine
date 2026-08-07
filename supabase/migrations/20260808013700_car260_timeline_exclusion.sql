-- CAR-260: strike a timeline entry from every derived calculation.
--
-- `is_excluded` means "this row stays in the record but must not count toward
-- anything derived": stage inference, company traction, network health, streaks,
-- heatmaps, last-touch, dossier grounding, aggregate counts. It is deliberately
-- NOT the same flag as email_messages.is_hidden, which is display-only and
-- honored by exactly three inbox reads. Exclusion is a strict SUPERSET of
-- hidden: the app sets is_hidden whenever it sets is_excluded on an email, so
-- the surfaces that already filter is_hidden need no change. The reverse is not
-- true, and must not become true, or every email a user ever archived out of
-- their inbox would retroactively stop counting.
--
-- The model to copy here is email_messages.is_simulated, whose whole job is the
-- same thing. Its lesson is a warning as much as a pattern: it is applied at 6
-- of the ~22 sites that derive something from email, and nothing catches the
-- gap. `npm run check:conventions` gains a guard requiring every read of these
-- tables to filter is_excluded or carry an `// exclusion-exempt:` reason.
--
-- NOT NULL DEFAULT false throughout, following is_trashed/is_hidden rather than
-- the nullable is_simulated, so no reader has to handle a third state.
--
-- No CHECK enforcing the superset invariant. Unhiding an excluded email from
-- the inbox Hidden tab clears both flags (that tab is the undo surface for
-- email), and a CHECK would turn any future path that clears only is_hidden
-- into a hard write failure rather than a recoverable inconsistency.

ALTER TABLE email_messages        ADD COLUMN IF NOT EXISTS is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_events       ADD COLUMN IF NOT EXISTS is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE meetings              ADD COLUMN IF NOT EXISTS is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE interactions          ADD COLUMN IF NOT EXISTS is_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE follow_up_action_items ADD COLUMN IF NOT EXISTS is_excluded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN email_messages.is_excluded IS
  'User struck this from the record: still stored and still in Gmail, but excluded from every derived calculation. Superset of is_hidden. Never written by sync.';
COMMENT ON COLUMN calendar_events.is_excluded IS
  'User struck this from the record: still stored and still in Google Calendar, but excluded from every derived calculation. Never written by sync.';
COMMENT ON COLUMN meetings.is_excluded IS
  'User struck this from the record: still stored, but excluded from every derived calculation.';
COMMENT ON COLUMN interactions.is_excluded IS
  'User struck this from the record: still stored, but excluded from every derived calculation.';
COMMENT ON COLUMN follow_up_action_items.is_excluded IS
  'User struck this from the record: still stored, but excluded from every derived calculation.';

-- ── The mirror-interaction link ─────────────────────────────────────────────
--
-- sendTrackedEmail writes an interactions row for every send (email-send.ts)
-- so last_touch updates and the contact stops surfacing as a Reach Out
-- suggestion. Nothing linked it to the message it mirrors, which caused two
-- problems: the contact timeline rendered one send as two entries, and
-- excluding the email left its last-touch effect fully intact, because
-- buildLastTouchMap reads interactions and meetings and never email_messages.

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS email_message_id integer REFERENCES email_messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN interactions.email_message_id IS
  'The sent email this interaction mirrors (email-send.ts). Null for interactions logged by hand or by import.';

-- email_messages rows ARE hard-deleted (revokeAccess, moveMessageToLabel), and
-- an unindexed FK makes every one of those a sequential scan of interactions.
CREATE INDEX IF NOT EXISTS idx_interactions_email_message_id
  ON interactions (email_message_id)
  WHERE email_message_id IS NOT NULL;

-- Backfill.
--
-- email-send.ts computes a single `sentAt` today and writes it to both
-- email_messages.date and interactions.interaction_date, and the Gmail sync's
-- safe-field update rewrites only subject, snippet, label_ids and thread_id, so
-- `date` is never overwritten afterward. An exact-equality join is therefore
-- correct for everything sent by the current code, and it matched 62 of the 70
-- mirror rows in production.
--
-- It is NOT correct for the older rows, and measuring beat assuming here: the
-- remaining 8 split into 4 whose email row no longer exists at all (nothing can
-- link those) and 4 that match on subject and contact but sit 0.3 to 1.1
-- SECONDS apart, because the code that wrote them called new Date() twice. So
-- the join carries a two-second window, and the identity of the match rests on
-- the exact subject plus the same contact rather than on the timestamp: sending
-- a byte-identical subject to the same contact twice inside two seconds is not
-- a thing that happens, and a duplicate row on the timeline is the cost of
-- being wrong in the other direction.
--
-- DISTINCT ON with a full ORDER BY so one interaction claims exactly one
-- message, closest in time first and the lowest id as the tiebreak, rather than
-- whichever row the planner happened to reach first.
--
-- The contact leg goes through the junction rather than matched_contact_id
-- because a send to an address shared by two contacts writes one interaction
-- per contact (CAR-159).
WITH candidate AS (
  SELECT DISTINCT ON (i.id)
    i.id  AS interaction_id,
    em.id AS email_message_id
  FROM interactions i
  JOIN email_messages em
    ON em.direction = 'outbound'
   AND i.summary = 'Sent: ' || em.subject
   AND em.date BETWEEN i.interaction_date - interval '2 seconds'
                   AND i.interaction_date + interval '2 seconds'
  JOIN email_message_contacts emc
    ON emc.email_message_id = em.id
   AND emc.contact_id = i.contact_id
  WHERE i.interaction_type = 'email'
    AND i.email_message_id IS NULL
  ORDER BY i.id, abs(extract(epoch FROM (em.date - i.interaction_date))), em.id
)
UPDATE interactions i
SET email_message_id = c.email_message_id
FROM candidate c
WHERE c.interaction_id = i.id;
