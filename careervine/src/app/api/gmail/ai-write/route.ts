import { withApiHandler, ApiError } from "@/lib/api-handler";
import { gmailAiWriteSchema } from "@/lib/api-schemas";
import { runWithOpenAIFallback, DEFAULT_MODEL, AiUnavailableError } from "@/lib/openai";
import { getContactContext } from "@/lib/ai-helpers";
import { sanitizeAiDraftHtml } from "@/lib/ai/sanitize-email-html";
import { UNTRUSTED_DATA_CLAUSE } from "@/lib/ai/untrusted";

/**
 * POST /api/gmail/ai-write
 * Generate an email using AI with contact context and optional meeting notes.
 */
export const POST = withApiHandler({
  schema: gmailAiWriteSchema,
  // CAR-51: spend cap on shared-key AI — far above any human drafting pace.
  rateLimit: { bucket: "careervine-ai-write", limit: 40, window: "1 h", failClosed: true },
  handler: async ({ user, body, track }) => {
    const { prompt, contactId, meetingIds, additionalContext, subject } = body;
    const startedAt = Date.now();

    // ── Gather context via shared helper ──
    const ctx = contactId
      ? await getContactContext(user.id, contactId, meetingIds)
      : await getContactContext(user.id, 0); // fallback: just get sender info

    const senderName = ctx.senderName;
    const contactContext = ctx.contactInfo;
    const meetingContext = ctx.meetingNotes;

    // ── Build the AI prompt ──

    const systemPrompt = `You are an expert email writer helping a professional craft personalized emails.
Write the email body only — do NOT include a subject line, greeting preamble like "Subject:", or sign-off signature.
Start directly with the greeting (e.g., "Hi [Name],") and end just before where a signature would go.
Write in a natural, professional tone. Be concise but warm. Avoid being overly formal or stiff.
Use the contact's information to personalize the email meaningfully — reference their work, background, shared connections, or recent meetings where relevant.
Output clean HTML suitable for an email body (use <p> tags for paragraphs, <br> for line breaks within paragraphs). Do not use markdown.

${UNTRUSTED_DATA_CLAUSE}`;

    const userParts: string[] = [];
    userParts.push(`EMAIL TYPE/INSTRUCTIONS: ${prompt}`);

    if (senderName) userParts.push(`\nSENDER: ${senderName} (${ctx.senderEmail})`);

    if (contactContext) userParts.push(`\nRECIPIENT INFORMATION:\n${contactContext}`);

    if (meetingContext) userParts.push(`\nMEETING NOTES/TRANSCRIPTS:\n${meetingContext}`);

    if (subject) userParts.push(`\nEXISTING SUBJECT LINE: ${subject}`);

    if (additionalContext) userParts.push(`\nADDITIONAL CONTEXT FROM USER: ${additionalContext}`);

    // ── Call OpenAI ──

    const model = DEFAULT_MODEL;

    let response;
    try {
      response = await runWithOpenAIFallback(user.id, (openai) =>
        openai.responses.create({
          model,
          instructions: systemPrompt,
          input: userParts.join("\n"),
          max_output_tokens: 2000,
        }),
      );
    } catch (err) {
      if (err instanceof AiUnavailableError) throw err;
      console.error("[ai-write] OpenAI API error:", err);
      throw new ApiError("Failed to generate email. Please try again.", 500);
    }

    // Never return raw model HTML (CAR-143, R5.2)
    const emailHtml = sanitizeAiDraftHtml(response.output_text || "");

    if (!emailHtml.trim()) {
      throw new ApiError("AI returned an empty response. Please try again.", 500);
    }

    // Also generate a subject line if none provided
    let generatedSubject: string | null = null;
    if (!subject) {
      try {
        const subjectResponse = await runWithOpenAIFallback(user.id, (openai) =>
          openai.responses.create({
            model,
            instructions: "Generate a concise, professional email subject line for the following email. Return ONLY the subject line text, nothing else. No quotes.",
            input: emailHtml,
            max_output_tokens: 100,
          }),
        );
        // Interior line breaks would corrupt the MIME Subject header (R5.1)
        generatedSubject =
          subjectResponse.output_text?.replace(/[\r\n]+/g, " ").trim() || null;
      } catch {
        // Subject generation is best-effort; use null if it fails
      }
    }

    track("ai_draft_generated", { kind: "write", latency_ms: Date.now() - startedAt });
    return {
      success: true,
      bodyHtml: emailHtml,
      subject: generatedSubject,
    };
  },
});
