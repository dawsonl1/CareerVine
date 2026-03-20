/**
 * Zod validation schemas for all API routes.
 *
 * Naming convention:  <domain><Action>Schema
 * e.g. gmailSendSchema, calendarCreateEventSchema
 */

import { z } from "zod";
import { AiFollowUpDraftStatus } from "@/lib/constants";

// ── Shared primitives ──────────────────────────────────────────────────

const optionalString = z.string().optional();
const optionalNumber = z.coerce.number().optional();

// ── Gmail ──────────────────────────────────────────────────────────────

export const gmailAuthQuerySchema = z.object({
  scopes: optionalString,
});

export const gmailSendSchema = z.object({
  to: z.string().min(1, "to is required"),
  subject: z.string().min(1, "subject is required"),
  cc: optionalString,
  bcc: optionalString,
  bodyHtml: optionalString,
  threadId: optionalString,
  inReplyTo: optionalString,
  references: optionalString,
});

export const gmailEmailsQuerySchema = z.object({
  contactId: z.string().min(1, "contactId is required"),
});

export const gmailEmailMoveSchema = z.object({
  labelId: z.string().min(1, "labelId is required"),
});

export const gmailDraftSchema = z.object({
  id: z.number().optional(),
  to: optionalString,
  cc: optionalString,
  bcc: optionalString,
  subject: optionalString,
  bodyHtml: optionalString,
  threadId: optionalString,
  inReplyTo: optionalString,
  references: optionalString,
  contactName: optionalString,
});

export const gmailTemplateSchema = z.object({
  id: z.number().optional(),
  name: z.string().min(1, "name is required"),
  prompt: z.string().min(1, "prompt is required"),
  sort_order: z.number().optional().default(0),
});

export const gmailAiWriteSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  recipientEmail: optionalString,
  contactId: z.number().optional(),
  meetingIds: z.array(z.number()).optional(),
  additionalContext: optionalString,
  subject: optionalString,
});

export const gmailAiWriteMeetingsQuerySchema = z.object({
  contactId: z.string().min(1, "contactId is required"),
});

export const gmailAiWriteResolveContactQuerySchema = z.object({
  email: z.string().min(1, "email is required"),
});

const followUpMessageSchema = z.object({
  sendAfterDays: z.number().int().min(1, "sendAfterDays must be at least 1"),
  subject: z.string(),
  bodyHtml: z.string(),
  sendTime: z.string().regex(/^\d{1,2}:\d{2}$/, "sendTime must be HH:MM format").optional(),
});

export const gmailFollowUpCreateSchema = z.object({
  originalGmailMessageId: z.string().min(1, "originalGmailMessageId is required"),
  threadId: z.string().min(1, "threadId is required"),
  recipientEmail: z.string().min(1, "recipientEmail is required"),
  contactName: optionalString,
  originalSubject: optionalString,
  originalSentAt: z.string(),
  scheduledEmailId: z.number().optional(),
  messages: z.array(followUpMessageSchema).min(1, "At least one message is required"),
});

export const gmailFollowUpQuerySchema = z.object({
  threadId: optionalString,
});

export const gmailFollowUpUpdateSchema = z.object({
  messages: z.array(followUpMessageSchema).min(1, "At least one message is required"),
});

export const gmailScheduleCreateSchema = z.object({
  to: z.string().min(1, "to is required"),
  subject: z.string().min(1, "subject is required"),
  bodyHtml: optionalString,
  scheduledSendAt: z.string().min(1, "scheduledSendAt is required"),
  cc: optionalString,
  bcc: optionalString,
  threadId: optionalString,
  inReplyTo: optionalString,
  references: optionalString,
  contactName: optionalString,
  matchedContactId: z.number().optional(),
});

export const gmailScheduleQuerySchema = z.object({
  contactId: optionalString,
});

export const gmailScheduleUpdateSchema = z.object({
  to: optionalString,
  cc: optionalString,
  bcc: optionalString,
  subject: optionalString,
  bodyHtml: optionalString,
  scheduledSendAt: optionalString,
});

// ── Calendar ───────────────────────────────────────────────────────────

export const calendarEventsQuerySchema = z.object({
  start: optionalString,
  end: optionalString,
});

export const calendarSyncQuerySchema = z.object({
  force: optionalString,
});

export const calendarEventPatchSchema = z.object({
  summary: optionalString,
  description: optionalString,
  startTime: optionalString,
  endTime: optionalString,
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: "At least one field must be provided" },
);

export const calendarCreateEventSchema = z.object({
  summary: z.string().min(1, "summary is required"),
  startTime: z.string().min(1, "startTime is required"),
  endTime: z.string().min(1, "endTime is required"),
  description: optionalString,
  attendeeEmails: z.array(z.string()).optional(),
  conferenceType: z.enum(["meet", "zoom", "none"]).optional(),
  meetingId: z.number().optional(),
  sourceThreadId: optionalString,
  sourceMessageId: optionalString,
});

export const calendarAvailabilityQuerySchema = z.object({
  start: z.string().min(1, "start is required"),
  end: z.string().min(1, "end is required"),
  daysOfWeek: optionalString,
  windowStart: optionalString,
  windowEnd: optionalString,
  duration: optionalNumber,
  bufferBefore: optionalNumber,
  bufferAfter: optionalNumber,
  profile: optionalString,
});

export const calendarAvailabilityProfileSchema = z.object({
  profile: z.enum(["standard", "priority"]),
  data: z.object({
    days: z.array(z.number()).optional(),
    windowStart: optionalString,
    windowEnd: optionalString,
    duration: z.number().optional(),
    bufferBefore: z.number().optional(),
    bufferAfter: z.number().optional(),
  }),
});

export const calendarBusyCalendarsSchema = z.object({
  busyCalendarIds: z.array(z.string()),
});

// ── Contacts ───────────────────────────────────────────────────────────

export const contactsSearchQuerySchema = z.object({
  q: z.string().min(1, "Search query is required"),
});

export const contactsCheckDuplicateSchema = z.object({
  linkedinUrl: optionalString,
  name: optionalString,
  email: optionalString,
});

export const contactsImportSchema = z.object({
  profileData: z.record(z.string(), z.unknown()),
  photoUrl: z.string().url().optional(),
});

// ── Transcripts ────────────────────────────────────────────────────────

export const transcriptTranscribeSchema = z.object({
  meetingId: z.number().int().optional(),
  attachmentObjectPath: z.string().min(1, "attachmentObjectPath is required"),
});

export const transcriptParseSchema = z.object({
  rawText: z.string().min(1, "rawText is required").max(200000, "Text too large (200KB max)"),
});

// ── AI Follow-Up Drafts ─────────────────────────────────────────────

export const aiFollowUpGenerateSchema = z.object({
  contactIds: z.array(z.number().int()).min(1).max(3),
});

const aiDraftStatuses = Object.values(AiFollowUpDraftStatus) as [string, ...string[]];

export const aiFollowUpPatchSchema = z.object({
  status: z.enum(aiDraftStatuses).optional(),
  subject: z.string().optional(),
  bodyHtml: z.string().optional(),
  sendAsReply: z.boolean().optional(),
});

// ── Smart Suggestions ─────────────────────────────────────────────────

export const suggestionsSaveSchema = z.object({
  contactId: z.number().int(),
  title: z.string().min(1),
  description: z.string().optional(),
  reasonType: z.string().min(1),
  headline: z.string().min(1),
  evidence: z.string().min(1),
  /** When true, creates the action item as already completed (user already did it) */
  completed: z.boolean().optional(),
});

// ── Transcript Action Extraction ──────────────────────────────────────

export const transcriptMatchSpeakersSchema = z.object({
  speakerLabels: z.array(z.string().min(1)).min(1),
  speakerSamples: z.record(z.string(), z.string().max(5000)),
  contactContext: z.array(z.object({
    id: z.number().int(),
    name: z.string(),
    industry: z.string().optional(),
    emails: z.array(z.string()).optional(),
  })),
  meetingTitle: z.string().max(500).optional(),
});

export const transcriptExtractActionsSchema = z.object({
  meetingId: z.number().int(),
  transcript: z.string().min(1).max(200000),
  attendees: z.array(z.object({
    id: z.number().int(),
    name: z.string().max(100),
  })),
  meetingDate: z.string().min(1),
});

// ── Extension ──────────────────────────────────────────────────────────

export const extensionParseProfileSchema = z.object({
  cleanedText: z.string().min(1, "cleanedText is required"),
  profileUrl: optionalString,
});
