import { z } from "zod";
import { withApiHandler, ApiError } from "@/lib/api-handler";
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

    // Validate that the client's step matches the DB
    const { data: onboardingRow } = await service
      .from("user_onboarding")
      .select("current_step")
      .eq("user_id", user.id)
      .single();

    if (!onboardingRow || onboardingRow.current_step !== currentStep) {
      throw new ApiError("Step mismatch", 400);
    }

    if (currentStep === "complete") {
      throw new ApiError("Onboarding already complete", 400);
    }

    const nextStep = getNextStep(currentStep);

    // Special side effect: read_reply -> view_meeting
    // Create a simulated past meeting so the calendar/transcript step has something to show.
    // Must be in the past so the edit form shows Notes + Transcript fields (not future-meeting layout).
    if (currentStep === "read_reply" && nextStep?.id === "view_meeting") {
      try {
        const now = Date.now();
        // Place the meeting 1 hour ago — still shows on today's dashboard schedule
        const startTime = new Date(now - 60 * 60 * 1000).toISOString();
        const endTime = new Date(now - 15 * 60 * 1000).toISOString(); // 45 min meeting

        // Create Google Calendar event
        const { googleEventId } = await createCalendarEvent(user.id, {
          summary: "Networking Chat with Dawson Pitcher",
          description: "Informational interview — CareerVine onboarding",
          startTime,
          endTime,
          conferenceType: "none",
        });

        // Also write directly to calendar_events cache so the dashboard shows it
        // immediately (the sync has a 5-min cooldown and only fetches future events).
        const { data: emailRow } = await service
          .from("contact_emails")
          .select("contact_id, contacts!inner(user_id)")
          .eq("email", ONBOARDING_CONTACT_EMAIL)
          .eq("contacts.user_id", user.id)
          .single();

        const contactId = emailRow?.contact_id ?? null;

        await service.from("calendar_events").upsert({
          user_id: user.id,
          google_event_id: googleEventId,
          calendar_id: "primary",
          title: "Networking Chat with Dawson Pitcher",
          description: "Informational interview — CareerVine onboarding",
          start_at: startTime,
          end_at: endTime,
          all_day: false,
          location: null,
          meet_link: null,
          status: "confirmed",
          attendees: [],
          is_private: false,
          recurring_event_id: null,
          contact_id: contactId,
          synced_at: new Date().toISOString(),
        });

        if (contactId) {
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
              contact_id: contactId,
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
      // Clean up calendar event and associated meeting on completion
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
        // Delete the onboarding meeting row (cascades to meeting_contacts)
        await service
          .from("meetings")
          .delete()
          .eq("user_id", user.id)
          .eq("calendar_event_id", onboarding.onboarding_calendar_event_id);

        // Delete the local calendar_events cache entry
        await service
          .from("calendar_events")
          .delete()
          .eq("user_id", user.id)
          .eq("google_event_id", onboarding.onboarding_calendar_event_id);
      }

      updatePayload.completed_at = new Date().toISOString();
      updatePayload.onboarding_calendar_event_id = null;
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
