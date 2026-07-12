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
  // Post-OAuth landing path (CAR-50 onboarding connects from a modal).
  // Same-origin relative paths only — validated in auth and callback.
  // (Gmail + Calendar are always requested together now — CAR-100 — so there
  // is no longer a `scopes` param selecting which services to request.)
  returnTo: optionalString,
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
  /** Whether the body originated from an AI draft (CAR-38 acceptance metric). */
  aiAssisted: z.boolean().optional(),
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

// Pipeline bulk import (plan 24). Chunked ≤50 people per request to stay
// inside Vercel wall-clock limits — the load script chunks and loops.
export const contactsBulkImportSchema = z.object({
  batch: z.string().max(200).optional(),
  people: z
    .array(
      z.object({
        record: z.record(z.string(), z.unknown()),
        tracker: z
          .object({
            stage: z.string().max(100).nullish(),
            last_touch: z.string().max(100).nullish(),
            next_action: z.string().max(500).nullish(),
            next_action_date: z.string().max(100).nullish(),
            notes: z.string().max(10000).nullish(),
          })
          .nullish(),
      }),
    )
    .min(1)
    .max(50),
});

export const targetCompaniesBulkImportSchema = z.object({
  companies: z
    .array(
      z.object({
        name: z.string().min(1).max(300),
        linkedin_url: z.string().max(500).nullish(),
        // Stable LinkedIn identity (CAR-44): sheets that know the numeric
        // company id / slug should send them so imported rows unify with
        // scraper-created rows instead of minting identity-less splits.
        linkedin_company_id: z.string().max(50).nullish(),
        universal_name: z.string().max(200).nullish(),
        priority_score: z.number().nullish(),
        tier: z.string().max(200).nullish(),
        program_name: z.string().max(300).nullish(),
        app_window_text: z.string().max(2000).nullish(),
      }),
    )
    .min(1)
    .max(400),
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
  /** Client-computed share of the AI draft that survived to send (CAR-58) —
   * only the client has the original AI body to diff against. */
  editRatio: z.number().min(0).max(1).optional(),
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
  /** When set, the suggestion is backed by a contact_change_events row to mark actioned (plan 29) */
  changeEventId: z.number().int().optional(),
});

export const changeEventDismissSchema = z.object({
  changeEventId: z.number().int(),
});

export const scrapeContactSchema = z.object({
  /** 'profile' = refresh only; 'email' = also run SMTP-verified email search */
  mode: z.enum(["profile", "email"]).optional(),
});

export const linkLinkedinSchema = z.object({
  linkedinUrl: z.string().min(1).max(500),
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
  userName: z.string().max(100).optional(),
});

// ── AI (intro email flow) ──────────────────────────────────────────────

export const aiDraftIntroSchema = z.object({
  contactId: z.number().int().positive(),
  howMet: z.string().optional(),
  goal: z.string().optional(),
  notes: z.string().optional(),
});

export const aiDraftFollowUpsSchema = z.object({
  contactId: z.number().int().positive(),
  introSubject: z.string().min(1),
  introBodyHtml: z.string().min(1),
  goal: z.string().optional(),
  howMet: z.string().optional(),
});

// ── Extension ──────────────────────────────────────────────────────────

export const extensionParseProfileSchema = z.object({
  // Cleaned profile text is typically <15k chars; the cap bounds OpenAI cost
  // if a buggy or malicious client posts raw page dumps.
  cleanedText: z
    .string()
    .min(1, "cleanedText is required")
    .max(60_000, "cleanedText is too long"),
  profileUrl: optionalString,
});

// ── Settings / BYO OpenAI key ──────────────────────────────────────────

export const openaiKeySaveSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(20, "API key is too short")
    .max(200, "API key is too long")
    .regex(/^sk-/, "API key must start with sk-"),
});

// ── Settings / BYO Deepgram key ────────────────────────────────────────

// Deepgram API keys are 40-character lowercase hex strings with no prefix.
// Validate on shape here; the route additionally makes a live call to Deepgram
// before storing. Custom message so Zod never echoes the submitted value.
export const deepgramKeySaveSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{40}$/, "That doesn't look like a Deepgram API key."),
});

// ── Data bundles (plan 29) ─────────────────────────────────────────────

/** Admin publish flow — secret-token route, staged under a publish lock. */
export const bundlePublishSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("begin"),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be kebab-case"),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  }),
  z.object({
    mode: z.literal("prospects"),
    slug: z.string().min(1),
    stagingVersion: z.number().int().positive(),
    /** BundleProspectPayloadV1[] — or raw pipeline PeopleRecords when
     * peopleFormat is 'people_record' (converted server-side). */
    people: z.array(z.unknown()).min(1).max(50),
    peopleFormat: z.enum(["payload", "people_record"]).default("payload"),
  }),
  z.object({
    mode: z.literal("companies"),
    slug: z.string().min(1),
    stagingVersion: z.number().int().positive(),
    companies: z.array(z.unknown()).min(1).max(50),
  }),
  z.object({
    mode: z.literal("finalize"),
    slug: z.string().min(1),
    stagingVersion: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal("abort"),
    slug: z.string().min(1),
    stagingVersion: z.number().int().positive(),
  }),
  /** Post-finalize snapshot resolution (CAR-62): cursor-driven; runs against
   * the committed version, so no stagingVersion/lock. The final call stamps
   * resolved_version and performs the subscriber fan-out. pinnedVersion is
   * captured on the first call and threaded back so the whole loop stays on
   * one committed version — a concurrent publish mid-loop then makes the
   * resolved_version guard miss (leaving the bundle unresolved for the cron
   * to heal) instead of stamping over a stale snapshot. */
  z.object({
    mode: z.literal("resolve"),
    slug: z.string().min(1),
    afterId: z.number().int().nonnegative().nullable().optional(),
    pinnedVersion: z.number().int().positive().optional(),
  }),
]);

/** Admin grant/revoke of shared-token access (CAR-26) — secret-token route.
 * Identify the user by uuid or email; at least one is required. */
export const adminAiAccessSchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().email().optional(),
    sharedAccess: z.boolean(),
  })
  .refine((d) => Boolean(d.userId || d.email), {
    message: "userId or email is required",
  });

/** User-facing bundle subscription endpoints. */
export const bundleSubscribeSchema = z.object({
  bundleId: z.number().int().positive(),
});

export const bundleApplySchema = z.object({
  bundleId: z.number().int().positive(),
  cursor: z
    .object({
      phase: z.enum(["apply", "remove", "fast"]),
      afterId: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  /** Committed bundle version pinned on the loop's first call — later
   * calls must pass it back so a concurrent publish can't skew the delta. */
  pinnedVersion: z.number().int().positive().optional(),
  /** Sync-claim token from the previous call (CAS renewal). */
  claimToken: z.string().optional(),
});

export const bundleUnsubscribeSchema = z.object({
  bundleId: z.number().int().positive(),
  keepAll: z.boolean(),
  cursor: z.number().int().nonnegative().nullable().optional(),
});
