/**
 * Shared application-level TypeScript types
 *
 * These types are derived from the Supabase schema but enriched with
 * join data that pages commonly need. Using these avoids duplicating
 * long inline type literals across page components.
 *
 * Convention:
 *   - Row types come from Database["public"]["Tables"][T]["Row"]
 *   - Enriched types add nested join objects (e.g. contact_emails)
 *   - Simple types (SimpleContact) are lightweight projections for pickers
 */

import type { Database } from "./database.types";

// ── Row type aliases ──

export type UserRow = Database["public"]["Tables"]["users"]["Row"];
export type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
export type MeetingRow = Database["public"]["Tables"]["meetings"]["Row"];
export type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];
export type ActionItemRow = Database["public"]["Tables"]["follow_up_action_items"]["Row"];
export type TagRow = Database["public"]["Tables"]["tags"]["Row"];
export type CompanyRow = Database["public"]["Tables"]["companies"]["Row"];
export type CompanyLocationRow = Database["public"]["Tables"]["company_locations"]["Row"];
export type TargetCompanyRow = Database["public"]["Tables"]["target_companies"]["Row"];
export type TargetCompanyNoteRow = Database["public"]["Tables"]["target_company_notes"]["Row"];
export type LocationRow = Database["public"]["Tables"]["locations"]["Row"];

// ── Enriched types (with joins) ──

/** Contact with all related data as returned by getContacts() */
export type Contact = ContactRow & {
  locations: Database["public"]["Tables"]["locations"]["Row"] | null;
  contact_emails: Database["public"]["Tables"]["contact_emails"]["Row"][];
  contact_phones: Database["public"]["Tables"]["contact_phones"]["Row"][];
  contact_companies: (Database["public"]["Tables"]["contact_companies"]["Row"] & {
    companies: Database["public"]["Tables"]["companies"]["Row"];
  })[];
  contact_schools: (Database["public"]["Tables"]["contact_schools"]["Row"] & {
    schools: Database["public"]["Tables"]["schools"]["Row"];
  })[];
  contact_tags: (Database["public"]["Tables"]["contact_tags"]["Row"] & {
    tags: Database["public"]["Tables"]["tags"]["Row"];
  })[];
};

/**
 * Lean projection of {@link Contact} for the contacts list (CAR-94). The list
 * only reads company/school/tag *names* plus the narrow join rows, so the wide
 * leaf tables are trimmed to id+name and the unused `locations` join is dropped
 * from the payload. Used only by getContactsStreamed and the contacts page; the
 * full Contact stays the shared shape everywhere else.
 */
export type ContactListItem = ContactRow & {
  contact_emails: Database["public"]["Tables"]["contact_emails"]["Row"][];
  contact_phones: Database["public"]["Tables"]["contact_phones"]["Row"][];
  contact_companies: (Database["public"]["Tables"]["contact_companies"]["Row"] & {
    companies: Pick<Database["public"]["Tables"]["companies"]["Row"], "id" | "name">;
  })[];
  contact_schools: (Database["public"]["Tables"]["contact_schools"]["Row"] & {
    schools: Pick<Database["public"]["Tables"]["schools"]["Row"], "id" | "name">;
  })[];
  contact_tags: (Database["public"]["Tables"]["contact_tags"]["Row"] & {
    tags: Pick<Database["public"]["Tables"]["tags"]["Row"], "id" | "name">;
  })[];
};

/** Meeting with attendee contacts as returned by getMeetings() */
export type Meeting = MeetingRow & {
  meeting_contacts: (Database["public"]["Tables"]["meeting_contacts"]["Row"] & {
    contacts: ContactRow;
  })[];
};

/** Interaction with contact name as returned by getAllInteractions() */
export type InteractionWithContact = {
  id: number;
  contact_id: number;
  interaction_date: string;
  interaction_type: string;
  summary: string | null;
  contacts: { id: number; name: string };
};

/** Lightweight contact projection for pickers and dropdowns */
export type SimpleContact = {
  id: number;
  name: string;
  email?: string;
  emails?: string[];
  photo_url?: string | null;
};

/** Action item with contact info as returned by getActionItemsForMeeting() */
export type ActionItemWithContacts = {
  id: number;
  title: string;
  description: string | null;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  contacts: { id: number; name: string } | null;
  action_item_contacts?: {
    contact_id: number;
    contacts: { id: number; name: string } | null;
  }[];
};

/** Meeting action items map: meetingId → action items */
export type MeetingActionsMap = Record<number, ActionItemWithContacts[]>;

/** Contact meeting (lightweight, from getMeetingsForContact) */
export type ContactMeeting = {
  id: number;
  meeting_date: string;
  meeting_type: string | null;
  title: string | null;
  notes: string | null;
  private_notes: string | null;
  calendar_description: string | null;
  transcript: string | null;
};

/** Follow-up reminder as returned by getContactsDueForFollowUp() */
export type FollowUpReminder = {
  id: number;
  name: string;
  industry: string | null;
  follow_up_frequency_days: number;
  last_touch: string | null;
  days_overdue: number;
};

// ── Gmail types ──

/** Gmail connection status (safe projection without tokens) */
export type GmailConnection = {
  id: number;
  gmail_address: string;
  last_gmail_sync_at: string | null;
  created_at: string | null;
  // CAR-100: false when the user granted Calendar but unchecked Gmail on the
  // shared consent screen. "Gmail connected" gates on this, not row existence.
  send_scope_granted: boolean;
};

/** Cached email metadata row */
export type EmailMessage = Database["public"]["Tables"]["email_messages"]["Row"];

// ── Timeline types ──

export type CompletedActionEntry = {
  id: number;
  title: string;
  completed_at: string | null;
};

export type TimelineEntry =
  | { kind: "meeting"; date: string; data: ContactMeeting }
  | { kind: "interaction"; date: string; data: InteractionRow }
  | { kind: "email"; date: string; data: EmailMessage }
  | { kind: "completed_action"; date: string; data: CompletedActionEntry };

/** Full email content as returned by the message detail endpoint */
export type EmailMessageFull = {
  subject: string;
  from: string;
  to: string;
  date: string;
  bodyHtml: string | null;
  bodyText: string | null;
  messageId: string;
  threadId: string;
};

// ── Scheduled email types ──

/** A queued email waiting to be sent */
export type ScheduledEmail = Database["public"]["Tables"]["scheduled_emails"]["Row"];

// ── Email follow-up types ──

/** A follow-up sequence with its messages */
export type EmailFollowUp = Database["public"]["Tables"]["email_follow_ups"]["Row"] & {
  email_follow_up_messages: EmailFollowUpMessage[];
  /** Resolved at read time from recipient_email → contact_emails (CAR-127). */
  matched_contact_id?: number | null;
};

/** Individual follow-up message in a sequence */
export type EmailFollowUpMessage = Database["public"]["Tables"]["email_follow_up_messages"]["Row"];

/** Email draft — auto-saved compose state */
export type EmailDraft = Database["public"]["Tables"]["email_drafts"]["Row"] & {
  /** Resolved at read time from recipient_email → contact_emails (CAR-127). */
  matched_contact_id?: number | null;
};

/** Email template — user-defined AI email generation template */
export type EmailTemplate = Database["public"]["Tables"]["email_templates"]["Row"];

/** Current role/company/office for an outreach recipient row (CAR-127). */
export type ContactEmployment = {
  id: number;
  name: string;
  title: string | null;
  company_id: number | null;
  company_name: string | null;
  location_label: string | null;
};

// ── Transcript types ──

/** Single transcript segment row */
export type TranscriptSegmentRow = Database["public"]["Tables"]["transcript_segments"]["Row"];

/** Transcript segment with optional resolved contact name */
export type TranscriptSegment = TranscriptSegmentRow & {
  contacts?: { id: number; name: string } | null;
};
