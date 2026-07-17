import { withApiHandler, ApiError } from "@/lib/api-handler";
import { aiDraftFollowUpsSchema } from "@/lib/api-schemas";
import { runWithOpenAIFallback, DEFAULT_MODEL, AiUnavailableError } from "@/lib/openai";
import { getContactContext } from "@/lib/ai-helpers";
import { sanitizeAiDraftHtml } from "@/lib/ai/sanitize-email-html";
import { wrapUntrusted, UNTRUSTED_DATA_CLAUSE } from "@/lib/ai/untrusted";

/**
 * POST /api/ai/draft-follow-ups
 * Generate 3 follow-up reply emails based on the approved intro email.
 */
export const POST = withApiHandler({
  schema: aiDraftFollowUpsSchema,
  // CAR-51: spend cap on shared-key AI — far above any human drafting pace.
  rateLimit: { bucket: "careervine-ai-draft-follow-ups", limit: 30, window: "1 h", failClosed: true },
  handler: async ({ user, body, track }) => {
    const { contactId, introSubject, introBodyHtml, goal, howMet } = body;
    const startedAt = Date.now();

    const ctx = await getContactContext(user.id, contactId);

    // The contact name is LinkedIn/user-sourced but sits inside the SYSTEM
    // prompt — strip line breaks and angle brackets so it can't fake
    // structure there (CAR-143).
    const safeContactName = ctx.contactName.replace(/[\r\n<>]+/g, " ").trim();

    const systemPrompt = `You are helping a college student write follow-up emails for a networking outreach sequence.

The student has already sent an introduction email (provided below). Generate exactly 3 follow-up emails that would be sent as REPLIES to the original email thread if the recipient doesn't respond.

Format your response EXACTLY like this (repeat for each follow-up):

FOLLOW_UP_1:
SUBJECT: Re: [original subject]
BODY:
[HTML body here]

FOLLOW_UP_2:
SUBJECT: Re: [original subject]
BODY:
[HTML body here]

FOLLOW_UP_3:
SUBJECT: Re: [original subject]
BODY:
[HTML body here]

Guidelines for each follow-up:
- Follow-up 1 (sent ~7 days later): Friendly check-in. Short. Reference the original email briefly. Keep the same warm tone.
- Follow-up 2 (sent ~14 days later): Add value — mention something relevant to the goal (an article, insight, or question). Slightly different angle than follow-up 1.
- Follow-up 3 (sent ~21 days later): Final gentle bump. Very brief (2-3 sentences). Acknowledge they're busy. Leave the door open.

Each follow-up should:
- Be progressively shorter
- Be a reply in the same thread (Re: subject)
- Reference the original email naturally
- Match the tone of the original
- Start with "Hi ${safeContactName}," and end before a signature
- Output clean HTML (<p> tags for paragraphs)
- Not repeat the same opening across follow-ups

${UNTRUSTED_DATA_CLAUSE}`;

    const userParts: string[] = [];
    userParts.push(`ORIGINAL SUBJECT: ${introSubject}`);
    // The intro body is user-approved but may embed AI/context-derived text —
    // fence it like the other free-text spans (CAR-143).
    userParts.push(`\nORIGINAL EMAIL BODY:\n${wrapUntrusted("prior_email_body", introBodyHtml)}`);
    if (goal) userParts.push(`\nSTUDENT'S GOAL: ${goal}`);
    if (howMet) userParts.push(`\nHOW THEY KNOW EACH OTHER: ${howMet}`);
    if (ctx.contactInfo) userParts.push(`\nRECIPIENT INFO:\n${ctx.contactInfo}`);
    if (ctx.senderName) userParts.push(`\nSENDER: ${ctx.senderName}`);

    let response;
    try {
      response = await runWithOpenAIFallback(user.id, (openai) =>
        openai.responses.create({
          model: DEFAULT_MODEL,
          instructions: systemPrompt,
          input: userParts.join("\n"),
          max_output_tokens: 4000,
        }),
      );
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      console.error("[draft-follow-ups] OpenAI API error:", err);
      throw new ApiError("Failed to generate follow-ups. Please try again.", 500);
    }

    const output = response.output_text || "";
    if (!output.trim()) {
      throw new ApiError("AI returned an empty response. Please try again.", 500);
    }

    // Parse the 3 follow-ups
    const followUps: Array<{ subject: string; bodyHtml: string; delayDays: number }> = [];
    const delays = [7, 14, 21];

    for (let i = 1; i <= 3; i++) {
      const sectionRegex = new RegExp(
        `FOLLOW_UP_${i}:[\\s\\S]*?SUBJECT:\\s*(.+?)\\n[\\s\\S]*?BODY:\\s*([\\s\\S]*?)(?=FOLLOW_UP_${i + 1}:|$)`
      );
      const match = output.match(sectionRegex);

      if (match) {
        followUps.push({
          // Line-break strip (R5.1) + tight sanitize (R5.2) on model output
          subject: match[1].replace(/[\r\n]+/g, " ").trim(),
          bodyHtml: sanitizeAiDraftHtml(match[2].trim()),
          delayDays: delays[i - 1],
        });
      } else {
        // Fallback: generate a simple follow-up (sanitized — contactName is
        // LinkedIn-sourced and interpolated into HTML)
        followUps.push({
          subject: `Re: ${introSubject}`,
          bodyHtml: sanitizeAiDraftHtml(
            `<p>Hi ${ctx.contactName},</p><p>Just wanted to follow up on my previous email. I'd love to connect when you have a moment.</p><p>Best regards</p>`,
          ),
          delayDays: delays[i - 1],
        });
      }
    }

    track("ai_draft_generated", { kind: "follow_up", latency_ms: Date.now() - startedAt });
    return { followUps };
  },
});
