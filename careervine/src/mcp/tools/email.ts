/**
 * Email tools (plan 26, tools 7–14).
 *
 * Drafting is the default path; send_email is confirm-gated and flows
 * through the app's shared sendTrackedEmail() (daily cap, bounce
 * refusal, caching, interaction logging, no tier graduation). Bounced
 * addresses are refused on every path — draft, send, schedule, sequence.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDraft, getFullMessage } from "@/lib/gmail";
import { sendTrackedEmail } from "@/lib/email-send";
import { buildFollowUpMessageRows } from "@/lib/follow-up-helpers";
import { resolveCapabilities } from "@/lib/capabilities/resolve";
import {
  uid,
  resolveContact,
  getContactFull,
  createScheduledEmail,
  createAppDraft,
  listScheduled,
  cancelScheduledEmail,
  cancelFollowUpSequence,
  searchEmailHistory,
  getCachedThreadMessages,
  findOriginalOutbound,
  insertFollowUpSequence,
} from "../lib/db";
import { resolveRecipient, type EmailRowLike } from "../lib/email-policy";
import { sanitizeStoredEmailHtml } from "@/lib/ai/sanitize-email-html";
import { markdownToHtml } from "../lib/markdown";
import { handler, contactRefShape } from "../lib/tool-utils";

/**
 * MCP bodies come straight from an LLM, and markdownToHtml passes raw HTML
 * through untouched — sanitize every body before it is stored or sent, the
 * same email-safe profile the web write paths apply (CAR-143, R5.2).
 */
function toSafeEmailHtml(body: string): string {
  return sanitizeStoredEmailHtml(markdownToHtml(body));
}

// CAR-143 (R5.1): MCP args come straight from an LLM — reject CR/LF in any
// string that gets interpolated into a MIME header (subject, recipient).
const NO_LINE_BREAKS = /^[^\r\n]*$/;
const NO_LINE_BREAKS_MESSAGE = "must not contain line breaks";

const composeShape = {
  ...contactRefShape,
  subject: z.string().min(1).regex(NO_LINE_BREAKS, NO_LINE_BREAKS_MESSAGE),
  body: z.string().min(1).describe("Email body as markdown (converted to HTML) or raw HTML"),
  thread_id: z.string().optional().describe("Gmail thread id to reply into (threads the message)"),
  to_email: z
    .string()
    .regex(NO_LINE_BREAKS, NO_LINE_BREAKS_MESSAGE)
    .optional()
    .describe("Override recipient address (defaults to the contact's primary email)"),
};

async function resolveComposeTarget(ref: { contact_id?: number; name?: string }, toOverride?: string) {
  const contact = await resolveContact(ref);
  const full = (await getContactFull(contact.id)) as unknown as { contact_emails: EmailRowLike[] };
  const recipient = resolveRecipient(contact.name, full.contact_emails, toOverride);
  return { contact, recipient };
}

/**
 * Resolve RFC threading headers for a reply. Gmail groups a sent message into
 * the thread server-side via threadId, but recipients' mail clients thread on
 * In-Reply-To / References — so set them from the newest message's RFC
 * Message-ID. Best-effort: returns {} when the thread isn't cached or the
 * live fetch fails (the message still threads in the sender's Gmail).
 */
async function resolveReplyHeaders(
  threadId: string | undefined,
): Promise<{ inReplyTo?: string; references?: string }> {
  if (!threadId) return {};
  try {
    const cached = await getCachedThreadMessages(threadId);
    const last = cached.at(-1) as { gmail_message_id?: string } | undefined;
    if (!last?.gmail_message_id) return {};
    const full = await getFullMessage(uid(), last.gmail_message_id);
    if (!full.messageId) return {};
    return { inReplyTo: full.messageId, references: full.messageId };
  } catch {
    return {};
  }
}

export const sendEmailSchema = {
  ...composeShape,
  confirm: z
    .literal(true)
    .describe("Must be true — confirms the user explicitly approved sending this email now"),
};

export const scheduleEmailSchema = {
  ...composeShape,
  send_at: z.string().describe("ISO 8601 timestamp for when to send"),
};

export const followUpSequenceSchema = {
  ...contactRefShape,
  thread_id: z.string().optional().describe("Gmail thread id of the original outbound email"),
  original_message_id: z.string().optional().describe("Gmail message id of the original outbound email"),
  messages: z
    .array(
      z.object({
        subject: z.string().min(1).regex(NO_LINE_BREAKS, NO_LINE_BREAKS_MESSAGE),
        body: z.string().min(1).describe("Markdown or HTML"),
        send_after_days: z.number().int().min(1).describe("Days after the original send"),
      }),
    )
    .min(1)
    .describe("Follow-up steps; the whole sequence auto-cancels if the contact replies"),
};

export function registerEmailTools(server: McpServer): void {
  server.registerTool(
    "create_email_draft",
    {
      title: "Create Gmail draft",
      description:
        "Create a real Gmail draft addressed to a contact (markdown body is converted to HTML). This is the DEFAULT path for written emails — prefer it unless the user explicitly says to send. Refuses bounced addresses; warns on pattern-guessed ones.",
      inputSchema: composeShape,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, subject, body, thread_id, to_email }) => {
      const { contact, recipient } = await resolveComposeTarget({ contact_id, name }, to_email);
      const reply = await resolveReplyHeaders(thread_id);
      const bodyHtml = toSafeEmailHtml(body);

      // Free tier holds no gmail.modify scope, so a real Gmail draft (drafts.create)
      // would 403. Fall back to an app-side draft (email_drafts), which the user
      // finishes and sends from the app (CAR-102).
      const caps = await resolveCapabilities(uid());
      if (!caps.has("drafts:gmail")) {
        const draftId = await createAppDraft({
          to: recipient.email,
          subject,
          bodyHtml,
          threadId: thread_id,
          inReplyTo: reply.inReplyTo,
          references: reply.references,
          contactName: contact.name,
        });
        return {
          summary: `Draft saved for ${contact.name} <${recipient.email}>. Open it in the app to review and send`,
          draft_id: draftId,
          warnings: recipient.warnings,
        };
      }

      const draft = await createDraft(uid(), {
        to: recipient.email,
        subject,
        bodyHtml,
        threadId: thread_id,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      });
      return {
        summary: `Draft created for ${contact.name} <${recipient.email}>. Review it in Gmail before sending`,
        draft_id: draft.draftId,
        gmail_url: draft.webUrl,
        warnings: recipient.warnings,
      };
    }),
  );

  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Send an email through the connected Gmail account, immediately. Requires confirm:true (only pass it when the user explicitly asked to send). Enforces the daily send cap and bounce refusal server-side; logs an interaction. Prefer create_email_draft when in doubt.",
      inputSchema: sendEmailSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, subject, body, thread_id, to_email }) => {
      const { contact, recipient } = await resolveComposeTarget({ contact_id, name }, to_email);
      const reply = await resolveReplyHeaders(thread_id);
      const result = await sendTrackedEmail(uid(), {
        to: recipient.email,
        subject,
        bodyHtml: toSafeEmailHtml(body),
        threadId: thread_id,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      });
      return {
        summary: `Sent to ${contact.name} <${recipient.email}>`,
        message_id: result.messageId,
        thread_id: result.threadId,
        sends_remaining_today: result.capRemaining,
        warnings: [...recipient.warnings, ...result.warnings],
      };
    }),
  );

  server.registerTool(
    "schedule_email",
    {
      title: "Schedule email",
      description:
        "Queue an email to send at a future time (the app's existing cron delivers it). Refuses bounced addresses.",
      inputSchema: scheduleEmailSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, subject, body, thread_id, to_email, send_at }) => {
      const when = new Date(send_at);
      if (Number.isNaN(when.getTime())) throw new Error(`Invalid send_at timestamp: ${send_at}`);
      if (when.getTime() <= Date.now()) throw new Error("send_at must be in the future — use send_email to send now");
      const { contact, recipient } = await resolveComposeTarget({ contact_id, name }, to_email);
      const reply = await resolveReplyHeaders(thread_id);
      const id = await createScheduledEmail({
        to: recipient.email,
        subject,
        bodyHtml: toSafeEmailHtml(body),
        scheduledSendAt: when.toISOString(),
        threadId: thread_id,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
        contactName: contact.name,
        matchedContactId: contact.id,
      });
      return {
        summary: `Scheduled for ${contact.name} <${recipient.email}> at ${when.toISOString()}`,
        scheduled_email_id: id,
        warnings: recipient.warnings,
      };
    }),
  );

  server.registerTool(
    "create_follow_up_sequence",
    {
      title: "Create follow-up sequence",
      description:
        "Attach timed follow-up messages to an already-sent email thread. The existing cron sends each step and auto-cancels the whole sequence if the contact replies (which also graduates prospects into the network).",
      inputSchema: followUpSequenceSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, thread_id, original_message_id, messages }) => {
      const contact = await resolveContact({ contact_id, name });
      const original = await findOriginalOutbound({ threadId: thread_id, messageId: original_message_id });
      const recipientEmail = original.to_addresses?.[0];
      if (!recipientEmail) throw new Error("Original message has no recipient address on record");

      const full = (await getContactFull(contact.id)) as unknown as { contact_emails: EmailRowLike[] };
      const known = full.contact_emails.find(
        (e) => e.email?.toLowerCase() === recipientEmail.toLowerCase(),
      );
      if (known?.bounced_at) {
        throw new Error(`${recipientEmail} has bounced — refusing to queue follow-ups to a dead address`);
      }
      const warnings: string[] = [];
      if (!known) {
        warnings.push(`${recipientEmail} is not one of ${contact.name}'s saved addresses, so double-check the thread`);
      }

      const sentAt = original.date ?? new Date().toISOString();
      // Steps are spaced relative to a base date. If the original went out
      // days/weeks ago (this tool can attach to any historical thread), basing
      // off sentAt would past-date every step — the cron then fires the whole
      // sequence in one tick (an immediate multi-email burst). Clamp the base
      // to now so send_after_days always schedules into the future.
      const baseIso = new Date(Math.max(new Date(sentAt).getTime(), Date.now())).toISOString();
      const rows = buildFollowUpMessageRows(
        0,
        messages.map((m) => ({
          sendAfterDays: m.send_after_days,
          subject: m.subject,
          bodyHtml: toSafeEmailHtml(m.body),
        })),
        new Date(baseIso),
      );
      const followUpId = await insertFollowUpSequence({
        originalGmailMessageId: original.gmail_message_id,
        threadId: original.thread_id ?? thread_id ?? "",
        recipientEmail,
        contactName: contact.name,
        originalSubject: original.subject,
        originalSentAt: sentAt,
        messageRows: rows,
      });
      return {
        summary: `${messages.length}-step follow-up sequence created for ${contact.name}; cancels automatically on reply`,
        follow_up_id: followUpId,
        first_send_at: rows[0]?.scheduled_send_at ?? null,
        warnings,
      };
    }),
  );

  server.registerTool(
    "list_scheduled",
    {
      title: "List scheduled sends",
      description: "Pending scheduled emails and active follow-up sequences with their next send times.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => listScheduled()),
  );

  server.registerTool(
    "cancel_scheduled",
    {
      title: "Cancel scheduled send",
      description: "Cancel a pending scheduled email or an entire active follow-up sequence.",
      inputSchema: {
        scheduled_email_id: z.number().int().optional(),
        follow_up_id: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async ({ scheduled_email_id, follow_up_id }) => {
      if (scheduled_email_id != null) {
        await cancelScheduledEmail(scheduled_email_id);
        return { summary: `Cancelled scheduled email ${scheduled_email_id}` };
      }
      if (follow_up_id != null) {
        await cancelFollowUpSequence(follow_up_id);
        return { summary: `Cancelled follow-up sequence ${follow_up_id}` };
      }
      throw new Error("Provide scheduled_email_id or follow_up_id");
    }),
  );

  server.registerTool(
    "search_email_history",
    {
      title: "Search email history",
      description:
        'Search cached Gmail messages by subject/snippet text, optionally scoped to one contact — e.g. "what did Tim say about referrals?".',
      inputSchema: {
        query: z.string().min(1),
        ...contactRefShape,
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ query, contact_id, name, limit }) => {
      let scopedContactId: number | undefined;
      if (contact_id != null || name) {
        scopedContactId = (await resolveContact({ contact_id, name })).id;
      }
      const results = await searchEmailHistory(query, scopedContactId, limit ?? 20);
      return { summary: `${results.length} message(s) match "${query}"`, results };
    }),
  );

  server.registerTool(
    "get_email_thread",
    {
      title: "Get email thread",
      description:
        "Full message bodies for a Gmail thread (live fetch, HTML converted where possible). Returns the most recent 10 messages of long threads.",
      inputSchema: { thread_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ thread_id }) => {
      const cached = await getCachedThreadMessages(thread_id);
      if (cached.length === 0) {
        throw new Error(`No cached messages for thread ${thread_id} — check the id or sync Gmail first`);
      }
      const recent = cached.slice(-10);

      // Free tier holds no mailbox-read scope, so the live getFullMessage hydration
      // below would 403. Serve the cached snippets instead (no full bodies) — CAR-102.
      const caps = await resolveCapabilities(uid());
      if (!caps.has("mailbox:read")) {
        return {
          thread_id,
          total_cached: cached.length,
          preview_only: true,
          messages: recent.map((m) => ({
            gmail_message_id: m.gmail_message_id,
            direction: m.direction,
            from: m.from_address,
            to: (m.to_addresses ?? []).join(", "),
            date: m.date,
            subject: m.subject,
            body: m.snippet ?? null,
            note: "preview only (upgrade for full message bodies)",
          })),
        };
      }

      const messages = await Promise.all(
        recent.map(async (m) => {
          try {
            const fullMsg = await getFullMessage(uid(), m.gmail_message_id);
            const body =
              fullMsg.bodyText ??
              (fullMsg.bodyHtml ? fullMsg.bodyHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : null);
            return {
              gmail_message_id: m.gmail_message_id,
              direction: m.direction,
              from: fullMsg.from,
              to: fullMsg.to,
              date: fullMsg.date,
              subject: fullMsg.subject,
              body,
            };
          } catch {
            return { ...m, body: null, note: "live fetch failed — snippet only" };
          }
        }),
      );
      return { thread_id, total_cached: cached.length, messages };
    }),
  );
}
