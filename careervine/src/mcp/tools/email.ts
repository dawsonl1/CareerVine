/**
 * Email tools (plan 26, tools 7–14).
 *
 * Drafting is the default path; send_email is confirm-gated and flows
 * through the app's shared sendTrackedEmail() (daily cap, bounce
 * refusal, caching, interaction logging, no tier graduation). Bounced
 * addresses are refused on every path — draft, send, schedule, sequence.
 *
 * ── Writing for an LLM caller (CAR-217) ─────────────────────────────────
 *
 * Every caller of this file is a model, which changes what a guardrail has to
 * look like to work. Three rules came out of a real incident where an agent
 * guessed three addresses, sent to all three, and reported all three as
 * delivered while two had bounced:
 *
 * 1. A warning returned beside a success payload does not stop anything. It is
 *    advisory text competing with the rest of the model's context. If a case
 *    must not proceed, THROW; if it may proceed only deliberately, gate it on a
 *    parameter the schema requires (`allow_unverified_address`). A model cannot
 *    forget to pass something it has to pass.
 * 2. The `summary` is the headline and everything else is a footnote. Anything
 *    that must not be misreported belongs in that sentence, not in a sibling
 *    field. `send_email` says "Handed to Gmail", never "Sent", for this reason.
 * 3. Tool descriptions are the only documentation the model reliably reads, so
 *    the verification rule lives in them rather than in a prompt or skill file
 *    that can drift out of agreement with the code.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDraft, getFullMessage, detectBounces } from "@/lib/gmail";
import { sendTrackedEmail } from "@/lib/email-send";
import { buildFollowUpMessageRows } from "@/lib/follow-up-helpers";
import { zonedTimeOfDay } from "@/lib/timezone";
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
  getUserTimeZone,
  getPendingScheduledEmail,
  assertNoActiveSequenceForScheduledEmail,
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
    .describe(
      "Override recipient address. Must be one of the contact's saved addresses; anything else is refused as a guess. Defaults to the contact's primary email.",
    ),
  allow_unverified_address: z
    .literal(true)
    .optional()
    .describe(
      "Only set this when the user themselves supplied an address CareerVine has never seen. NEVER set it to make a to_email you constructed or inferred go through: an address assembled from a name and a company domain is a guess, guesses bounce, and a bounce burns the contact and the sending reputation.",
    ),
};

async function resolveComposeTarget(
  ref: { contact_id?: number; name?: string },
  toOverride?: string,
  allowUnverified?: boolean,
) {
  const contact = await resolveContact(ref);
  const full = (await getContactFull(contact.id)) as unknown as { contact_emails: EmailRowLike[] };
  const recipient = resolveRecipient(contact.name, full.contact_emails, toOverride, {
    allowUnverified,
  });
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

const followUpStepShape = z.object({
  subject: z.string().min(1).regex(NO_LINE_BREAKS, NO_LINE_BREAKS_MESSAGE),
  body: z.string().min(1).describe("Markdown or HTML"),
  send_after_days: z.number().int().min(1).describe("Days after the original send"),
});

export const scheduleEmailSchema = {
  ...composeShape,
  send_at: z.string().describe("ISO 8601 timestamp for when to send"),
  follow_ups: z
    .array(followUpStepShape)
    .max(5)
    .optional()
    .describe(
      "Optional follow-up steps queued with this email in one call. They stay dormant until it sends, then reply on its thread and auto-cancel the moment the contact responds. Each goes out at the same time of day as the opening email.",
    ),
};

export const followUpSequenceSchema = {
  ...contactRefShape,
  thread_id: z.string().optional().describe("Gmail thread id of the original outbound email"),
  original_message_id: z.string().optional().describe("Gmail message id of the original outbound email"),
  scheduled_email_id: z
    .number()
    .int()
    .optional()
    .describe(
      "Id of a still-pending scheduled email to hang these follow-ups off (from schedule_email or list_scheduled). Use this when the opening email has not sent yet.",
    ),
  messages: z
    .array(followUpStepShape)
    .min(1)
    .describe("Follow-up steps; the whole sequence auto-cancels if the contact replies"),
};

/**
 * Build follow-up rows for an MCP-created sequence.
 *
 * `dateBaseIso` sets which day each step lands on; `timeAnchorIso` sets the
 * time of day they all inherit. Splitting the two matters on the historical-
 * thread path, where the day base is clamped to now but the time of day should
 * still come from the original send.
 *
 * ── Two tickets fixed the same bug from different ends ──────────────────
 *
 * `buildFollowUpMessageRows` used to default to `setUTCHours(9, 0)`, i.e. 09:00
 * UTC, so a carefully-timed 9:00 a.m. Mountain intro produced follow-ups that
 * fired at 3:00 a.m. Mountain.
 *
 * CAR-214 worked around it here, by inheriting the opening email's own time of
 * day so no timezone knowledge was needed. CAR-215 fixed the root cause: the
 * builder now resolves real IANA zones, and `sendTime` means LOCAL time.
 *
 * That reinterpretation is why this function had to change rather than merge
 * as-is. Feeding it a UTC hour once `sendTime` became local would have shifted
 * every MCP follow-up by the user's whole offset: a 2 p.m. Mountain intro
 * producing 9 p.m. follow-ups. So the anchor is read in the user's zone.
 *
 * Keeping CAR-214's intent this way is also strictly more faithful to it than
 * the original was. Pinning the UTC hour pins an instant-of-day, which drifts an
 * hour in local terms across a DST boundary; pinning the local wall clock is
 * what "the hour the conversation already uses" actually means to a person.
 */
export function buildMcpFollowUpRows(
  steps: Array<z.infer<typeof followUpStepShape>>,
  dateBaseIso: string,
  timeAnchorIso: string,
  timeZone: string,
) {
  const sendTime = zonedTimeOfDay(new Date(timeAnchorIso), timeZone);
  return buildFollowUpMessageRows(
    0,
    steps.map((m) => ({
      sendAfterDays: m.send_after_days,
      subject: m.subject,
      bodyHtml: toSafeEmailHtml(m.body),
      sendTime,
    })),
    new Date(dateBaseIso),
    timeZone,
  );
}

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
    handler(async ({ contact_id, name, subject, body, thread_id, to_email, allow_unverified_address }) => {
      const { contact, recipient } = await resolveComposeTarget({ contact_id, name }, to_email, allow_unverified_address);
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
        "Hand an email to the connected Gmail account for immediate delivery. Requires confirm:true (only pass it when the user explicitly asked to send). Enforces the daily send cap and bounce refusal server-side; logs an interaction. Prefer create_email_draft when in doubt. IMPORTANT: a successful result means Gmail ACCEPTED the message, not that it reached anyone. A rejection comes back minutes later as a separate bounce notice, so it is never visible in the sent folder or in this result. Use check_delivery to find out what actually landed, and never report an email as delivered on the strength of this call alone.",
      inputSchema: sendEmailSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, subject, body, thread_id, to_email, allow_unverified_address }) => {
      const { contact, recipient } = await resolveComposeTarget({ contact_id, name }, to_email, allow_unverified_address);
      const reply = await resolveReplyHeaders(thread_id);
      const result = await sendTrackedEmail(uid(), {
        to: recipient.email,
        subject,
        bodyHtml: toSafeEmailHtml(body),
        threadId: thread_id,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      });
      // The summary deliberately does NOT say "Sent", and this is the whole
      // point of CAR-217's MCP half. Gmail accepting a message is not delivery:
      // a 550 arrives minutes later in a separate thread that never appears
      // beside the sent copy. The old summary read "Sent to <name>", and an
      // agent relayed exactly that for three addresses, two of which bounced.
      // An LLM takes the summary as the headline and a sibling `warnings` array
      // as advisory, so the correction has to live in the sentence itself.
      return {
        summary:
          `Handed to Gmail for ${contact.name} <${recipient.email}>. Delivery is NOT confirmed: ` +
          `a bounce would arrive minutes from now as a separate notice. Do not tell the user this ` +
          `landed. Run check_delivery to confirm.`,
        delivery: "unconfirmed",
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
        "Queue an email to send at a future time (the app's existing cron delivers it). Refuses bounced addresses. Pass follow_ups to queue the whole sequence in this one call — the follow-ups wait for this email to send, then reply on its thread and cancel themselves if the contact writes back.",
      inputSchema: scheduleEmailSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, subject, body, thread_id, to_email, allow_unverified_address, send_at, follow_ups }) => {
      const when = new Date(send_at);
      if (Number.isNaN(when.getTime())) throw new Error(`Invalid send_at timestamp: ${send_at}`);
      if (when.getTime() <= Date.now()) throw new Error("send_at must be in the future — use send_email to send now");
      const { contact, recipient } = await resolveComposeTarget({ contact_id, name }, to_email, allow_unverified_address);
      const reply = await resolveReplyHeaders(thread_id);
      const sendAtIso = when.toISOString();
      const id = await createScheduledEmail({
        to: recipient.email,
        subject,
        bodyHtml: toSafeEmailHtml(body),
        scheduledSendAt: sendAtIso,
        threadId: thread_id,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
        contactName: contact.name,
        matchedContactId: contact.id,
      });

      const warnings = [...recipient.warnings];
      let followUp: { follow_up_id: number; steps: number; first_send_at: string | null } | null = null;

      if (follow_ups?.length) {
        // The email is already queued at this point. A sequence failure must
        // not throw: the caller would read the whole call as failed and could
        // reschedule, double-sending a real email. Report it as a warning
        // instead and name the exact recovery, which is a single follow-up
        // call against the id we are about to return.
        try {
          const rows = buildMcpFollowUpRows(follow_ups, sendAtIso, sendAtIso, await getUserTimeZone());
          const followUpId = await insertFollowUpSequence({
            // Both ids stay null until the opening email actually sends; the
            // scheduled-send cron back-fills them, and the follow-up cron's
            // `thread_id is not null` filter keeps the sequence dormant until
            // it does. A placeholder string would defeat that interlock.
            originalGmailMessageId: null,
            threadId: null,
            recipientEmail: recipient.email,
            contactName: contact.name,
            originalSubject: subject,
            originalSentAt: sendAtIso,
            contactId: contact.id,
            scheduledEmailId: id,
            messageRows: rows,
          });
          followUp = {
            follow_up_id: followUpId,
            steps: rows.length,
            first_send_at: rows[0]?.scheduled_send_at ?? null,
          };
        } catch (err) {
          warnings.push(
            `The email is scheduled, but its follow-ups could not be saved (${
              err instanceof Error ? err.message : String(err)
            }). Retry them alone with create_follow_up_sequence and scheduled_email_id: ${id} — do NOT call schedule_email again.`,
          );
        }
      }

      return {
        summary: followUp
          ? `Scheduled for ${contact.name} <${recipient.email}> at ${sendAtIso}, with ${followUp.steps} follow-up(s) queued behind it`
          : `Scheduled for ${contact.name} <${recipient.email}> at ${sendAtIso}`,
        scheduled_email_id: id,
        follow_up: followUp,
        warnings,
      };
    }),
  );

  server.registerTool(
    "create_follow_up_sequence",
    {
      title: "Create follow-up sequence",
      description:
        "Attach timed follow-up messages to an email thread. Anchor to an already-sent thread (thread_id / original_message_id), or to a still-pending scheduled_email_id when the opening email has not gone out yet. The existing cron sends each step and auto-cancels the whole sequence if the contact replies (which also graduates prospects into the network).",
      inputSchema: followUpSequenceSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, thread_id, original_message_id, scheduled_email_id, messages }) => {
      const contact = await resolveContact({ contact_id, name });

      /** Bounce refusal + unknown-address warning, shared by both anchors. */
      const checkRecipient = async (recipientEmail: string) => {
        const full = (await getContactFull(contact.id)) as unknown as { contact_emails: EmailRowLike[] };
        const known = full.contact_emails.find(
          (e) => e.email?.toLowerCase() === recipientEmail.toLowerCase(),
        );
        if (known?.bounced_at) {
          throw new Error(`${recipientEmail} has bounced — refusing to queue follow-ups to a dead address`);
        }
        return known
          ? []
          : [`${recipientEmail} is not one of ${contact.name}'s saved addresses, so double-check the thread`];
      };

      // Pre-send anchor (CAR-214): the opening email is still queued, so there
      // is no thread yet. Both ids stay null and the scheduled-send cron
      // back-fills them; until then the follow-up cron's `thread_id is not
      // null` filter keeps the sequence dormant.
      if (scheduled_email_id != null) {
        if (thread_id || original_message_id) {
          throw new Error(
            "Pass scheduled_email_id OR thread_id/original_message_id, not both — they name different anchors",
          );
        }
        const scheduled = await getPendingScheduledEmail(scheduled_email_id);
        await assertNoActiveSequenceForScheduledEmail(scheduled_email_id);
        const recipientEmail = scheduled.recipient_email;
        const warnings = await checkRecipient(recipientEmail);

        const rows = buildMcpFollowUpRows(
          messages,
          scheduled.scheduled_send_at,
          scheduled.scheduled_send_at,
          await getUserTimeZone(),
        );
        const followUpId = await insertFollowUpSequence({
          originalGmailMessageId: null,
          threadId: null,
          recipientEmail,
          contactName: contact.name,
          originalSubject: scheduled.subject,
          originalSentAt: scheduled.scheduled_send_at,
          contactId: contact.id,
          scheduledEmailId: scheduled.id,
          messageRows: rows,
        });
        return {
          summary: `${messages.length}-step follow-up sequence queued behind scheduled email ${scheduled.id} for ${contact.name}; starts only once that email sends, and cancels automatically on reply`,
          follow_up_id: followUpId,
          first_send_at: rows[0]?.scheduled_send_at ?? null,
          warnings,
        };
      }

      const original = await findOriginalOutbound({ threadId: thread_id, messageId: original_message_id });
      const recipientEmail = original.to_addresses?.[0];
      if (!recipientEmail) throw new Error("Original message has no recipient address on record");

      const warnings = await checkRecipient(recipientEmail);

      const sentAt = original.date ?? new Date().toISOString();
      // Steps are spaced relative to a base date. If the original went out
      // days/weeks ago (this tool can attach to any historical thread), basing
      // off sentAt would past-date every step — the cron then fires the whole
      // sequence in one tick (an immediate multi-email burst). Clamp the base
      // to now so send_after_days always schedules into the future.
      const baseIso = new Date(Math.max(new Date(sentAt).getTime(), Date.now())).toISOString();
      // Steps inherit the opening email's time of day (CAR-214) resolved in the
      // user's own zone (CAR-215). Both tickets independently fixed the same
      // 09:00-UTC default; keeping only one would regress the other.
      const timeZone = await getUserTimeZone();
      const rows = buildMcpFollowUpRows(messages, baseIso, sentAt, timeZone);
      const followUpId = await insertFollowUpSequence({
        originalGmailMessageId: original.gmail_message_id,
        threadId: original.thread_id ?? thread_id ?? "",
        recipientEmail,
        contactName: contact.name,
        originalSubject: original.subject,
        originalSentAt: sentAt,
        contactId: contact.id,
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
      const bounced = results.filter((r) => (r as { delivery?: string }).delivery === "bounced").length;
      return {
        summary:
          `${results.length} message(s) match "${query}"` +
          (bounced > 0
            ? `. ${bounced} of them went to an address that has since bounced (delivery: "bounced") and never reached anyone.`
            : ""),
        results,
      };
    }),
  );

  server.registerTool(
    "check_delivery",
    {
      title: "Check delivery",
      description:
        "Find out which recently sent emails actually failed. Reads the delivery failure notices in the mailbox, flags the dead addresses, and cancels anything still queued to them. Call this after sending, and before telling the user an email reached anyone: send_email only reports that Gmail ACCEPTED a message, and a rejection arrives minutes later as a separate notice that never appears next to the sent copy. Checking the sent folder cannot answer this question.",
      inputSchema: {
        since_days: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe("How far back to look for delivery failures (default 14)"),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async ({ since_days }) => {
      const result = await detectBounces(uid(), since_days ?? 14);
      if (result.newlyBounced.length === 0) {
        return {
          summary:
            result.bounced.length === 0
              ? "No delivery failures found. Note this is evidence of absence only as far back as the window checked, and a bounce for a very recent send may not have arrived yet."
              : `No NEW delivery failures. ${result.bounced.length} address(es) were already known to have bounced and are already blocked.`,
          newly_bounced: [],
          already_known: result.bounced,
        };
      }
      return {
        summary:
          `${result.newlyBounced.length} address(es) rejected mail permanently: ${result.newlyBounced.join(", ")}. ` +
          `Those messages did NOT reach anyone. Cancelled ${result.cancelledSequences} follow-up sequence(s) and ` +
          `${result.cancelledScheduled} scheduled email(s) aimed at them, and blocked further sends. ` +
          `Tell the user which sends failed, and do not re-send without a corrected address.`,
        newly_bounced: result.newlyBounced,
        already_known: result.bounced.filter((a) => !result.newlyBounced.includes(a)),
        cancelled_follow_up_sequences: result.cancelledSequences,
        cancelled_scheduled_emails: result.cancelledScheduled,
      };
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
