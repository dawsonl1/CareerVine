import { withApiHandler, ApiError } from "@/lib/api-handler";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import { transcriptParseSchema } from "@/lib/api-schemas";

/**
 * POST /api/transcripts/parse
 *
 * LLM fallback for parsing transcripts that don't match known regex formats.
 * Uses OpenAI to extract speaker turns from unstructured text.
 *
 * Input:  { rawText: string }
 * Output: { segments: { speaker_label, started_at?, content }[] }
 */
export const POST = withApiHandler({
  schema: transcriptParseSchema,
  handler: async ({ body }) => {
    const { rawText } = body;
    const openai = getOpenAIClient();
    const model = DEFAULT_MODEL;

    const segmentSchema = {
      name: "transcript_segments",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["segments"],
        properties: {
          segments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["speaker_label", "content"],
              properties: {
                speaker_label: { type: "string", description: "Speaker name or label" },
                started_at: { type: ["number", "null"], description: "Start time in seconds, if available" },
                content: { type: "string", description: "What the speaker said" },
              },
            },
          },
        },
      },
      strict: true,
    };

    const instructions =
      "You are a transcript parser. Extract speaker turns from the provided meeting transcript text. " +
      "Identify each distinct speaker and their dialogue. Return structured segments in chronological order. " +
      "Use the actual speaker names from the transcript when available. " +
      "If speakers are labeled numerically (Speaker 1, Speaker 2), preserve those labels. " +
      "Combine consecutive lines from the same speaker into one segment. " +
      "If timestamps are present, convert them to seconds from the start. " +
      "Return only the JSON matching the schema.";

    // Truncate very long transcripts to avoid token limits
    const maxChars = 50000;
    const truncated = rawText.length > maxChars ? rawText.slice(0, maxChars) : rawText;

    let response;
    try {
      response = await openai.responses.create({
        model,
        instructions,
        input: truncated,
        max_output_tokens: 16000,
        text: {
          format: {
            type: "json_schema",
            ...segmentSchema,
          },
        },
      });
    } catch (err) {
      console.error("[transcripts/parse] OpenAI API error:", err);
      throw new ApiError("Failed to parse transcript. Please try again.", 500);
    }

    const responseText = response.output_text || "";
    if (!responseText.trim()) {
      throw new ApiError("LLM returned an empty response", 500);
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[transcripts/parse] Failed to parse LLM response:", responseText.slice(0, 500));
      throw new ApiError("Failed to parse transcript. Please try again.", 500);
    }

    const segments = (parsed.segments || []).map((s: any, i: number) => ({
      speaker_label: s.speaker_label || "Unknown",
      started_at: typeof s.started_at === "number" ? s.started_at : null,
      ended_at: null,
      content: s.content || "",
      ordinal: i,
    }));

    return { segments };
  },
});
