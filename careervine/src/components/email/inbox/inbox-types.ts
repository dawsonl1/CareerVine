import type { ComponentType } from "react";
import type { EmailFollowUp } from "@/lib/types";

/** A Gmail user label offered in the "Move to folder" menus. */
export type GmailLabel = { id: string; name: string; type: string };

/** The seven left-nav destinations. */
export type SidebarTab = "inbox" | "sent" | "scheduled" | "followups" | "drafts" | "trash" | "hidden";

/** One left-nav entry (shared by the desktop sidebar and the mobile tab strip). */
export type SidebarItem = {
  key: SidebarTab;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count: number;
};

/** Which mailbox a thread list is rendering — drives per-tab action affordances. */
export type TabContext = "inbox" | "sent" | "trash" | "hidden";

/** A calendar event linked to a thread (badge on the thread row). */
export type LinkedCalendarEvent = {
  id: number;
  title: string | null;
  start_at: string;
  google_event_id: string;
};

/**
 * The payload the shell hands to the FollowUpModal. Child tabs raise it through
 * their `onOpenFollowUp` callback rather than owning modal state themselves.
 */
export type FollowUpModalPayload = {
  recipientEmail: string;
  contactName: string | null;
  originalSubject: string;
  originalSentAt: string;
  originalGmailMessageId: string;
  threadId: string;
  scheduledEmailId?: number | null;
  existingFollowUp?: EmailFollowUp | null;
};
