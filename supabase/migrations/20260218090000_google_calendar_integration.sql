-- Google Calendar Integration Migration
-- Adds calendar sync state, availability profiles, and calendar events cache

-- ── gmail_connections additions ──
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_scopes_granted boolean DEFAULT false;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_sync_token text;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_last_synced_at timestamptz;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_timezone text DEFAULT 'America/New_York';
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS calendar_list jsonb;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS busy_calendar_ids text[];
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS availability_standard jsonb;
ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS availability_priority jsonb;

-- availability shape: { days: int[], windowStart: "HH:MM", windowEnd: "HH:MM", duration: int, bufferBefore: int, bufferAfter: int }

-- ── calendar_events cache ──
CREATE TABLE IF NOT EXISTS calendar_events (
  id                      bigserial    PRIMARY KEY,
  user_id                 uuid         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_event_id         text         NOT NULL,
  calendar_id             text         NOT NULL DEFAULT 'primary',
  title                   text,
  description             text,
  start_at                timestamptz  NOT NULL,
  end_at                  timestamptz  NOT NULL,
  all_day                 boolean      DEFAULT false,
  location                text,
  meet_link               text,
  zoom_link               text,
  status                  text,                     -- confirmed | tentative | cancelled
  attendees               jsonb,                    -- [{email, name, responseStatus}]
  is_private              boolean      DEFAULT false,
  recurring_event_id      text,
  contact_id              int          REFERENCES contacts(id) ON DELETE SET NULL,
  meeting_id              int          REFERENCES meetings(id) ON DELETE SET NULL,
  source_gmail_thread_id  text,
  source_gmail_message_id text,
  synced_at               timestamptz  DEFAULT now(),
  created_at              timestamptz  DEFAULT now(),
  UNIQUE(user_id, google_event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_user_id ON calendar_events(user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contact_id ON calendar_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_meeting_id ON calendar_events(meeting_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at ON calendar_events(start_at);

-- ── calendar_event_contacts junction ──
CREATE TABLE IF NOT EXISTS calendar_event_contacts (
  calendar_event_id  bigint  NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  contact_id         int     NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (calendar_event_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_event_contacts_contact_id ON calendar_event_contacts(contact_id);

-- ── meetings table additions ──
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS calendar_event_id text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meet_link text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS zoom_link text;

-- ── RLS ──
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own calendar events" ON calendar_events;
CREATE POLICY "Users can manage own calendar events"
  ON calendar_events FOR ALL USING (auth.uid() = user_id);

ALTER TABLE calendar_event_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own calendar event contacts" ON calendar_event_contacts;
CREATE POLICY "Users can manage own calendar event contacts"
  ON calendar_event_contacts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM calendar_events ce
      WHERE ce.id = calendar_event_id AND ce.user_id = auth.uid()
    )
  );
