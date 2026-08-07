-- CAR-276: backfill the reply-implies-read invariant.
--
--     An inbound message is read if you sent an outbound message on the same
--     thread at a later time.
--
-- Going forward this is enforced in application code (careervine/src/lib/email-read.ts,
-- called from sendTrackedEmail and both Gmail sync ingest paths). Those are
-- event-driven: they fire when a send happens or when a sync ingests one of our
-- own messages. Neither revisits a thread that is already fully synced and quiet,
-- so every thread that got stuck BEFORE this shipped would stay stuck, counting
-- toward the nav unread badge indefinitely.
--
-- This is the one-time repair for that history. Monotonic, exactly like the
-- application path: it only ever sets is_read true, so it cannot undo a read
-- state the user established by opening a message.
--
-- Deliberately matches the application predicate row for row:
--   * strict `>` on the date comparison, so a message that landed at the same
--     instant we sent is not treated as one we answered;
--   * NULL dates on either side fail the comparison and are left unread, since
--     a message whose Date header was missing cannot be PROVEN to predate the
--     reply. Failing toward "still unread" costs a badge one too high, never a
--     message the user never learns about;
--   * `is_read IS FALSE` rather than `NOT is_read`, because the column is
--     nullable and NULL already reads as read everywhere downstream
--     (/api/gmail/unread counts `is_read = false`, not `IS NOT TRUE`).

UPDATE email_messages AS inbound
SET is_read = true
WHERE inbound.direction = 'inbound'
  AND inbound.is_read IS FALSE
  AND inbound.thread_id IS NOT NULL
  AND inbound.date IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM email_messages AS reply
    WHERE reply.user_id = inbound.user_id
      AND reply.thread_id = inbound.thread_id
      AND reply.direction = 'outbound'
      AND reply.date > inbound.date
  );
