import { withApiHandler, ApiError } from "@/lib/api-handler";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import { transcriptMatchSpeakersSchema } from "@/lib/api-schemas";

/**
 * POST /api/transcripts/match-speakers
 *
 * Uses OpenAI to match speaker labels from a transcript to known contacts.
 * Accepts speaker samples (excerpts per speaker) and contact context (names,
 * roles, companies) and returns match suggestions with confidence scores.
 *
 * Input:  { speakerLabels, speakerSamples, attendeeIds, contactContext, meetingTitle? }
 * Output: { matches: [{ speakerLabel, contactId, confidence, reason }] }
 */
export const POST = withApiHandler({
  schema: transcriptMatchSpeakersSchema,
  handler: async ({ body }) => {
    const { speakerLabels, speakerSamples, contactContext, meetingTitle } = body;

    if (contactContext.length === 0) {
      return { matches: [] };
    }

    const openai = getOpenAIClient();
    const model = DEFAULT_MODEL;

    const matchSchema = {
      name: "speaker_matches",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["matches"],
        properties: {
          matches: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["speaker_label", "contact_id", "confidence", "reason"],
              properties: {
                speaker_label: {
                  type: "string",
                  description: "The original speaker label from the transcript",
                },
                contact_id: {
                  type: ["integer", "null"],
                  description: "The contact ID this speaker most likely matches, or null if no good match",
                },
                confidence: {
                  type: "number",
                  description: "Confidence score from 0.0 to 1.0. Use >0.8 for strong matches (name match, clear role reference), 0.5-0.8 for plausible matches, <0.5 for weak guesses.",
                },
                reason: {
                  type: "string",
                  description: "Brief explanation of why this match was made",
                },
              },
            },
          },
        },
      },
      strict: true,
    };

    // Build contact profiles for the prompt
    const contactProfiles = contactContext
      .map((c) => {
        const parts = [`ID: ${c.id}, Name: ${c.name}`];
        if (c.role) parts.push(`Role: ${c.role}`);
        if (c.company) parts.push(`Company: ${c.company}`);
        if (c.emails?.length) parts.push(`Email: ${c.emails.join(", ")}`);
        return parts.join(", ");
      })
      .join("\n");

    // Build speaker samples section
    const speakerSamplesText = speakerLabels
      .map((label) => {
        const sample = speakerSamples[label];
        return `--- ${label} ---\n${sample || "(no sample text available)"}`;
      })
      .join("\n\n");

    const instructions =
      "You are matching speaker labels from a meeting transcript to known contacts. " +
      "For each speaker label, determine which contact (if any) is the most likely match. " +
      "Use these signals to match speakers:\n" +
      "- Name similarity: If the speaker label contains a name that matches a contact, that is a strong signal.\n" +
      "- Role/topic references: If a speaker discusses topics related to a contact's role (e.g., 'the design team' from a Designer), that is a moderate signal.\n" +
      "- Context clues: References to companies, projects, or specific expertise.\n" +
      "- For generic labels like 'Speaker 0' or 'Speaker 1', rely on content analysis.\n\n" +
      "Rules:\n" +
      "- Set contact_id to null if no contact is a good match.\n" +
      "- Do not assign the same contact to multiple speakers unless the evidence is very strong.\n" +
      "- Be conservative with confidence scores. Only use >0.8 for clear matches.\n" +
      "- Each speaker label must appear exactly once in your output.\n" +
      (meetingTitle ? `\nMeeting title: "${meetingTitle}"\n` : "") +
      "\n--- CONTACTS ---\n" +
      contactProfiles +
      "\n\n--- SPEAKER SAMPLES ---\n" +
      speakerSamplesText;

    const inputText = `Match these ${speakerLabels.length} speaker labels to the contacts listed above: ${speakerLabels.join(", ")}`;

    let response;
    try {
      response = await openai.responses.create({
        model,
        instructions,
        input: inputText,
        max_output_tokens: 2000,
        text: {
          format: {
            type: "json_schema",
            ...matchSchema,
          },
        },
      });
    } catch (err) {
      console.error("[match-speakers] OpenAI API error:", err);
      throw new ApiError("Failed to analyze speakers. Please try again.", 500);
    }

    const responseText = response.output_text || "";
    if (!responseText.trim()) {
      return { matches: [] };
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[match-speakers] Failed to parse LLM response:", responseText.slice(0, 500));
      throw new ApiError("Failed to parse speaker matches. Please try again.", 500);
    }

    const rawMatches = parsed.matches || [];

    // Normalize the response
    const matches = rawMatches.map((m: {
      speaker_label: string;
      contact_id: number | null;
      confidence: number;
      reason: string;
    }) => ({
      speakerLabel: m.speaker_label,
      contactId: m.contact_id,
      confidence: Math.max(0, Math.min(1, m.confidence)),
      reason: m.reason,
    }));

    return { matches };
  },
});
