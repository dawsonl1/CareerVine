import { withApiHandler, ApiError } from "@/lib/api-handler";
import { aiDraftIntroSchema } from "@/lib/api-schemas";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import { getContactContext } from "@/lib/ai-helpers";

/**
 * POST /api/ai/draft-intro
 * Generate a personalized intro email using AI with contact context + user-provided how-met/goal info.
 */
export const POST = withApiHandler({
  schema: aiDraftIntroSchema,
  handler: async ({ user, body }) => {
    const { contactId, howMet, goal, notes } = body;

    const ctx = await getContactContext(user.id, contactId);

    if (!ctx.contactName) {
      throw new ApiError("Contact not found", 404);
    }

    // Determine tone based on how they met
    const isColdOutreach = howMet?.toLowerCase().includes("haven't met");
    const toneInstruction = isColdOutreach
      ? "This is a COLD outreach — the sender has never met this person. Be respectful of their time, explain why you're reaching out, and keep it brief. Don't pretend you've met."
      : "This is a warm introduction — the sender has met or connected with this person before. Reference how they know each other naturally.";

    const systemPrompt = `You are helping a college student write a professional networking email.

Write BOTH a subject line AND an email body.

Format your response EXACTLY like this:
SUBJECT: [your subject line here]
BODY:
[your email body HTML here]

For the body:
- Start with a greeting (e.g., "Hi ${ctx.contactName},")
- End just before where a signature would go
- Be concise (3-5 short paragraphs max)
- Professional but warm — this is a student reaching out, not a corporate email
- Use the contact's information to personalize meaningfully
- Output clean HTML (use <p> tags for paragraphs)
- Do not use markdown

${toneInstruction}`;

    const userParts: string[] = [];

    if (ctx.senderName) userParts.push(`SENDER: ${ctx.senderName}`);
    if (ctx.contactInfo) userParts.push(`\nRECIPIENT INFORMATION:\n${ctx.contactInfo}`);
    if (howMet) userParts.push(`\nHOW THEY KNOW EACH OTHER: ${howMet}`);
    if (goal) userParts.push(`\nGOAL OF THIS EMAIL: ${goal}`);
    if (notes) userParts.push(`\nSPECIFIC THINGS TO MENTION: ${notes}`);
    if (ctx.meetingNotes) userParts.push(`\nPAST INTERACTIONS:\n${ctx.meetingNotes}`);

    const openai = getOpenAIClient();

    let response;
    try {
      response = await openai.responses.create({
        model: DEFAULT_MODEL,
        instructions: systemPrompt,
        input: userParts.join("\n"),
        max_output_tokens: 2000,
      });
    } catch (err) {
      console.error("[draft-intro] OpenAI API error:", err);
      throw new ApiError("Failed to generate email. Please try again.", 500);
    }

    const output = response.output_text || "";
    if (!output.trim()) {
      throw new ApiError("AI returned an empty response. Please try again.", 500);
    }

    // Parse SUBJECT: and BODY: from the response
    let subject = "";
    let bodyHtml = "";

    const subjectMatch = output.match(/SUBJECT:\s*(.+?)(?:\n|BODY:)/);
    const bodyMatch = output.match(/BODY:\s*([\s\S]+)/);

    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    }
    if (bodyMatch) {
      bodyHtml = bodyMatch[1].trim();
    } else {
      // Fallback: use entire output as body
      bodyHtml = output.trim();
    }

    return { subject, bodyHtml };
  },
});
