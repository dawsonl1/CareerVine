-- CAR-152 (R2.1): one-time calendar sync repair.
--
-- 1) Null every stored calendar sync token. A sync token is only valid under
--    the request settings that established it; CAR-152 flips ingestion to
--    singleEvents:true, so all pre-existing tokens describe a stream we no
--    longer request. The sync route already handles a null token by running a
--    windowed full fetch, which rebuilds each user's cache with expanded
--    recurring instances.
UPDATE gmail_connections
SET calendar_sync_token = NULL
WHERE calendar_sync_token IS NOT NULL;

-- 2) The repair CAR-133 omitted: before the tenant-scoping fix, the attendee
--    match ran globally across contact_emails, so calendar rows could point at
--    ANOTHER tenant's contact. Incremental sync never revisits unchanged
--    events, so those rows persist until scrubbed here.
UPDATE calendar_events
SET contact_id = NULL
FROM contacts c
WHERE calendar_events.contact_id = c.id
  AND c.user_id <> calendar_events.user_id;

DELETE FROM calendar_event_contacts
USING calendar_events ce, contacts c
WHERE calendar_event_contacts.calendar_event_id = ce.id
  AND calendar_event_contacts.contact_id = c.id
  AND c.user_id <> ce.user_id;
