import OpenAI from "openai";
import { withApiHandler, ApiError } from "@/lib/api-handler";
import { transcriptExtractActionsSchema } from "@/lib/api-schemas";
import { matchSpeakerToAttendee, resolveDueDate } from "@/lib/transcript-action-helpers";

/**
 * POST /api/transcripts/extract-actions
 *
 * Sends a meeting transcript to OpenAI and extracts concrete action items.
 * Maps speaker names to meeting attendees and resolves relative due dates.
 *
 * Input:  { meetingId, transcript, attendees: [{id, name}], meetingDate }
 * Output: { suggestions: [{ title, description, contactId, contactName, dueDate, evidence, assignedSpeaker }] }
 */
export const POST = withApiHandler({
  schema: transcriptExtractActionsSchema,
  handler: async ({ body }) => {
    const { transcript, attendees, meetingDate } = body;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new ApiError("OpenAI API key not configured", 500);

    const openai = new OpenAI({ apiKey });
    const model = process.env.OPENAI_MODEL ?? "gpt-5-mini";

    const actionItemSchema = {
      name: "extracted_action_items",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["action_items"],
        properties: {
          action_items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "assigned_to", "evidence"],
              properties: {
                title: {
                  type: "string",
                  description: "A concise, actionable task description (e.g., 'Send resume to hiring manager')",
                },
                description: {
                  type: ["string", "null"],
                  description: "Additional context about the task, if relevant",
                },
                assigned_to: {
                  type: "string",
                  description: "The speaker name who committed to this task. Use the exact speaker label from the transcript.",
                },
                due_date_hint: {
                  type: ["string", "null"],
                  description: "Relative due date if mentioned (e.g., 'by Friday', 'next week', 'end of month'). Null if no deadline was mentioned.",
                },
                evidence: {
                  type: "string",
                  description: "The exact quote or close paraphrase from the transcript where this commitment was made",
                },
              },
            },
          },
        },
      },
      strict: true,
    };

    const attendeeList = attendees.map((a) => a.name).join(", ");

    const instructions =
      "You are analyzing a meeting transcript to extract action items. " +
      "An action item is a specific commitment, task, follow-up, or deliverable that someone agreed to do. " +
      "Only extract CONCRETE commitments — things someone explicitly said they would do. " +
      "Do NOT extract vague social niceties like 'we should catch up sometime' or 'let me know if you need anything'. " +
      "Do NOT extract things that already happened during the meeting. " +
      "Focus on future tasks: sending documents, making introductions, scheduling follow-ups, researching something, etc. " +
      (attendeeList
        ? `The meeting attendees are: ${attendeeList}. Use these names when identifying who committed to each task.`
        : "Identify speakers by their labels in the transcript.") +
      " Return an empty array if no concrete action items are found.";

    // Truncate very long transcripts
    const maxChars = 50000;
    const truncated = transcript.length > maxChars ? transcript.slice(0, maxChars) : transcript;

    const response = await openai.responses.create({
      model,
      instructions,
      input: truncated,
      max_output_tokens: 4000,
      text: {
        format: {
          type: "json_schema",
          ...actionItemSchema,
        },
      },
    });

    const responseText = response.output_text || "";
    if (!responseText.trim()) {
      return { suggestions: [] };
    }

    let parsed;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      console.error("[extract-actions] Failed to parse LLM response:", responseText.slice(0, 500));
      throw new ApiError("Failed to extract action items. Please try again.", 500);
    }

    const rawItems = parsed.action_items || [];

    // Map AI results to suggestions with resolved contacts and dates
    const suggestions = rawItems.map((item: {
      title: string;
      description: string | null;
      assigned_to: string;
      due_date_hint: string | null;
      evidence: string;
    }) => {
      const matched = matchSpeakerToAttendee(item.assigned_to, attendees);

      return {
        title: item.title,
        description: item.description || null,
        contactId: matched?.id ?? null,
        contactName: matched?.name ?? null,
        dueDate: resolveDueDate(item.due_date_hint, meetingDate),
        evidence: item.evidence,
        assignedSpeaker: item.assigned_to,
      };
    });

    return {
      suggestions,
      truncated: transcript.length > maxChars,
    };
  },
});
