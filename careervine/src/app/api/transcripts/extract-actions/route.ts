import { withApiHandler, ApiError } from "@/lib/api-handler";
import { getOpenAIClient, DEFAULT_MODEL } from "@/lib/openai";
import { transcriptExtractActionsSchema } from "@/lib/api-schemas";
import { matchSpeakerToAttendee, resolveDueDate } from "@/lib/transcript-action-helpers";

/**
 * POST /api/transcripts/extract-actions
 *
 * Sends a meeting transcript to OpenAI and extracts concrete action items
 * with ownership direction (my_task, waiting_on).
 *
 * Input:  { meetingId, transcript, attendees: [{id, name}], meetingDate }
 * Output: { suggestions: [{ title, description, contactId, contactName, dueDate, evidence, assignedSpeaker, direction }] }
 */

const ACTION_ITEM_SCHEMA = {
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
          required: ["title", "description", "assigned_to", "direction", "due_date_hint", "evidence"],
          properties: {
            title: {
              type: "string",
              description: "A concise, actionable task description written from the user's perspective. For user's tasks: 'Send Alex your resume'. For contact's tasks: 'Alex will review your resume and give feedback'.",
            },
            description: {
              type: ["string", "null"],
              description: "Additional context about the task, if relevant",
            },
            assigned_to: {
              type: "string",
              description: "The speaker name who committed to this task. Use the exact speaker label from the transcript.",
            },
            direction: {
              type: "string",
              enum: ["my_task", "waiting_on"],
              description: "Who owns this action: 'my_task' = the user committed to doing this (including joint/mutual agreements since the user needs to initiate), 'waiting_on' = the contact offered or committed to doing this for the user",
            },
            due_date_hint: {
              type: ["string", "null"],
              description: "Relative due date if mentioned (e.g., 'by Friday', 'next week', 'in 4-6 weeks'). For ranges, use the midpoint (e.g., '4-6 weeks' → 'in 5 weeks'). Null if no deadline was mentioned.",
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
} as const;

export const POST = withApiHandler({
  schema: transcriptExtractActionsSchema,
  handler: async ({ body }) => {
    const { transcript, attendees, meetingDate, userName } = body;

    const openai = getOpenAIClient();
    const model = DEFAULT_MODEL;

    const attendeeList = attendees.map((a) => a.name).join(", ");

    // Build participant context for the prompt
    let participantContext: string;
    if (userName && attendeeList) {
      participantContext = `\nThe USER is "${userName}". The other attendees (contacts) are: ${attendeeList}. ` +
        `When "${userName}" commits to something, that is a my_task. When ${attendeeList} commits to something for the user, that is waiting_on.`;
    } else if (attendeeList) {
      participantContext = `\nThe contacts in this meeting are: ${attendeeList}. ` +
        "The user is the app owner (not listed above). Use context clues in the transcript to identify which speaker is the user.";
    } else {
      participantContext = "\nIdentify speakers by their labels in the transcript. The first speaker is likely the user.";
    }

    const instructions =
      "You are analyzing a meeting transcript to extract action items from ALL participants. " +
      "An action item is a specific commitment, task, follow-up, or deliverable that someone agreed to do.\n\n" +
      "Extract TWO types of commitments:\n" +
      "1. **my_task** — Things the USER explicitly committed to doing (sending documents, writing something, following up). Also classify joint/mutual agreements here (e.g., scheduling a follow-up together) since the user is the one who needs to initiate.\n" +
      "2. **waiting_on** — Things the CONTACT explicitly offered or committed to doing for the user (reviewing work, sending resources, making introductions). These are valuable — the user needs to track offers made to them so they can follow up if needed.\n\n" +
      "Rules:\n" +
      "- Extract CONCRETE commitments only — things someone explicitly said they would do\n" +
      "- Do NOT extract vague social niceties ('we should catch up sometime') or things that already happened\n" +
      "- Write titles from the user's perspective: 'Send Alex your resume' (my_task), 'Alex will review your project' (waiting_on), 'Schedule check-in with Alex in 4 weeks' (my_task)\n" +
      "- Be thorough — catch follow-up messages, scheduled check-ins, and offers of help from the contact\n" +
      "- For date ranges like '4-6 weeks', use the midpoint as the due_date_hint ('in 5 weeks')\n" +
      participantContext +
      "\n\nReturn an empty array if no concrete action items are found.";

    // Truncate very long transcripts
    const maxChars = 50000;
    const truncated = transcript.length > maxChars ? transcript.slice(0, maxChars) : transcript;

    let response;
    try {
      response = await openai.responses.create({
        model,
        instructions,
        input: truncated,
        max_output_tokens: 4000,
        text: {
          format: {
            type: "json_schema",
            ...ACTION_ITEM_SCHEMA,
          },
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[extract-actions] OpenAI API error:", errMsg);
      throw new ApiError(`Failed to extract action items: ${errMsg}`, 500);
    }

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
      direction: "my_task" | "waiting_on";
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
        direction: item.direction,
      };
    });

    return {
      suggestions,
      truncated: transcript.length > maxChars,
    };
  },
});
