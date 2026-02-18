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
  meeting_type: string;
  notes: string | null;
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
};

/** Cached email metadata row */
export type EmailMessage = Database["public"]["Tables"]["email_messages"]["Row"];

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
};

/** Individual follow-up message in a sequence */
export type EmailFollowUpMessage = Database["public"]["Tables"]["email_follow_up_messages"]["Row"];

/** Email draft — auto-saved compose state */
export type EmailDraft = Database["public"]["Tables"]["email_drafts"]["Row"];

/** Email template — user-defined AI email generation template */
export type EmailTemplate = Database["public"]["Tables"]["email_templates"]["Row"];
