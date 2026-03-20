import { withApiHandler } from "@/lib/api-handler";
import { calendarCreateEventSchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { createCalendarEvent } from "@/lib/calendar";

/**
 * POST /api/calendar/create-event
 * Creates a Google Calendar event with optional Google Meet conference.
 * Stores the event in the local cache and optionally links to a CareerVine meeting.
 */
export const POST = withApiHandler({
  schema: calendarCreateEventSchema,
  handler: async ({ user, body }) => {
    const {
      summary,
      description,
      startTime,
      endTime,
      attendeeEmails,
      conferenceType,
      meetingId,
      sourceThreadId,
      sourceMessageId,
    } = body;

    // Create event on Google Calendar
    const result = await createCalendarEvent(user.id, {
      summary,
      description,
      startTime,
      endTime,
      attendeeEmails,
      conferenceType: conferenceType || "none",
    });

    // Store in local cache
    const service = createSupabaseServiceClient();
    const { error: cacheErr } = await service.from("calendar_events").insert({
      user_id: user.id,
      google_event_id: result.googleEventId,
      calendar_id: "primary",
      title: summary,
      description: description || null,
      start_at: new Date(startTime).toISOString(),
      end_at: new Date(endTime).toISOString(),
      all_day: false,
      meet_link: result.meetLink,
      status: "confirmed",
      attendees: attendeeEmails?.map((email: string) => ({
        email,
        name: email,
        responseStatus: "needsAction",
      })) || [],
      source_gmail_thread_id: sourceThreadId || null,
      source_gmail_message_id: sourceMessageId || null,
    });

    if (cacheErr) {
      console.error("Error caching event:", cacheErr);
    }

    // Link to CareerVine meeting if provided
    if (meetingId) {
      await service
        .from("meetings")
        .update({
          calendar_event_id: result.googleEventId,
          meet_link: result.meetLink,
        })
        .eq("id", meetingId)
        .eq("user_id", user.id);
    }

    return {
      success: true,
      googleEventId: result.googleEventId,
      meetLink: result.meetLink,
    };
  },
});
