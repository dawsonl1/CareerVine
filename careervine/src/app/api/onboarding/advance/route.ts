import { z } from "zod";
import { withApiHandler } from "@/lib/api-handler";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getNextStep, ONBOARDING_CONTACT_EMAIL } from "@/components/onboarding/onboarding-steps";
import { createCalendarEvent, deleteCalendarEvent } from "@/lib/calendar";

const advanceSchema = z.object({
  currentStep: z.string(),
  skippedApollo: z.boolean().optional(),
});

/**
 * POST /api/onboarding/advance
 * Advances the onboarding step. Handles the read_reply -> view_meeting
 * transition by creating a Google Calendar event and meetings row.
 */
export const POST = withApiHandler({
  schema: advanceSchema,
  handler: async ({ user, body }) => {
    const { currentStep, skippedApollo } = body;
    const service = createSupabaseServiceClient();

    const nextStep = getNextStep(currentStep);

    // Special side effect: read_reply -> view_meeting
    // Create a simulated past meeting so the calendar step has something to show.
    if (currentStep === "read_reply" && nextStep?.id === "view_meeting") {
      try {
        const now = Date.now();
        const startTime = new Date(now - 75 * 60 * 1000).toISOString(); // 75 minutes ago
        const endTime = new Date(now - 30 * 60 * 1000).toISOString();   // 30 minutes ago

        // Create Google Calendar event
        const { googleEventId } = await createCalendarEvent(user.id, {
          summary: "Networking Chat with Dawson Pitcher",
          description: "Informational interview — CareerVine onboarding",
          startTime,
          endTime,
          conferenceType: "none",
        });

        // Find the Dawson contact via contact_emails
        const { data: emailRow } = await service
          .from("contact_emails")
          .select("contact_id, contacts!inner(user_id)")
          .eq("email", ONBOARDING_CONTACT_EMAIL)
          .eq("contacts.user_id", user.id)
          .single();

        if (emailRow?.contact_id) {
          // Create the meeting row
          const { data: meeting } = await service
            .from("meetings")
            .insert({
              user_id: user.id,
              meeting_date: startTime,
              meeting_type: "video",
              title: "Networking Chat with Dawson Pitcher",
              calendar_event_id: googleEventId,
            })
            .select("id")
            .single();

          if (meeting) {
            // Link meeting to Dawson contact
            await service.from("meeting_contacts").insert({
              meeting_id: meeting.id,
              contact_id: emailRow.contact_id,
            });
          }
        }

        // Store event ID in onboarding row for cleanup on skip
        await service
          .from("user_onboarding")
          .update({ onboarding_calendar_event_id: googleEventId })
          .eq("user_id", user.id);
      } catch (err) {
        // Don't block onboarding progress if calendar event creation fails
        console.error("[onboarding/advance] Failed to create meeting side effect:", err);
      }
    }

    // Build the update payload
    const updatePayload: Record<string, unknown> = {
      current_step: nextStep ? nextStep.id : "complete",
    };

    if (skippedApollo) {
      updatePayload.skipped_apollo = true;
    }

    if (!nextStep) {
      // Clean up calendar event on normal completion too
      const { data: onboarding } = await service
        .from("user_onboarding")
        .select("onboarding_calendar_event_id")
        .eq("user_id", user.id)
        .single();

      if (onboarding?.onboarding_calendar_event_id) {
        try {
          await deleteCalendarEvent(user.id, onboarding.onboarding_calendar_event_id);
        } catch (err) {
          console.error("Failed to delete onboarding calendar event:", err);
        }
      }

      updatePayload.completed_at = new Date().toISOString();
    }

    await service
      .from("user_onboarding")
      .update(updatePayload)
      .eq("user_id", user.id);

    return {
      nextStep: nextStep ?? null,
      completed: !nextStep,
    };
  },
});
