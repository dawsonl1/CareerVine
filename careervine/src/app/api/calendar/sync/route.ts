import { withApiHandler, ApiError } from "@/lib/api-handler";
import { calendarSyncQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { fetchCalendarEvents, getCalendarTimezone, getCalendarList, DEFAULT_TIMEZONE } from "@/lib/calendar";


const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (auto-sync)
const SYNC_FORCE_COOLDOWN_MS = 5 * 1000; // 5 seconds (manual sync button)

/**
 * POST /api/calendar/sync
 * Syncs Google Calendar events to the local cache.
 * Supports incremental sync via sync tokens.
 * Rate-limited to prevent abuse.
 */
export const POST = withApiHandler({
  querySchema: calendarSyncQuerySchema,
  handler: async ({ user, query }) => {
    const service = createSupabaseServiceClient();
    const conn = await service
      .from("gmail_connections")
      .select("calendar_scopes_granted, calendar_last_synced_at, calendar_sync_token, gmail_address")
      .eq("user_id", user.id)
      .single();

    if (!conn.data || !conn.data.calendar_scopes_granted) {
      throw new ApiError("Calendar not connected", 400);
    }

    // Rate limiting
    const force = query.force === "true";
    const lastSynced = conn.data.calendar_last_synced_at
      ? new Date(conn.data.calendar_last_synced_at).getTime()
      : 0;
    const cooldown = force ? SYNC_FORCE_COOLDOWN_MS : SYNC_COOLDOWN_MS;

    if (Date.now() - lastSynced < cooldown) {
      throw new ApiError("Synced recently, try again later.", 429);
    }

    // On first sync: fetch timezone and calendar list from Google
    if (!conn.data.calendar_last_synced_at) {
      try {
        const [tz, calList] = await Promise.all([
          getCalendarTimezone(user.id),
          getCalendarList(user.id),
        ]);
        const busyIds = calList
          .filter((c: any) => c.accessRole === "owner" || c.accessRole === "writer")
          .map((c: any) => c.id);

        await service.from("gmail_connections").update({
          calendar_timezone: tz || DEFAULT_TIMEZONE,
          calendar_list: calList,
          busy_calendar_ids: busyIds.length > 0 ? busyIds : ["primary"],
        }).eq("user_id", user.id);
      } catch (err) {
        console.error("Failed to fetch timezone/calendar list:", err);
      }
    }

    // Fetch events from Google Calendar
    let events: any[] = [];
    let nextSyncToken: string | null = null;

    try {
      const result = await fetchCalendarEvents(user.id, {
        syncToken: conn.data.calendar_sync_token,
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      });
      events = result.events;
      nextSyncToken = result.nextSyncToken || null;
    } catch (err: any) {
      if (err.message === "SYNC_TOKEN_EXPIRED") {
        await service
          .from("gmail_connections")
          .update({ calendar_sync_token: null })
          .eq("user_id", user.id);
        const result = await fetchCalendarEvents(user.id, {
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        });
        events = result.events;
        nextSyncToken = result.nextSyncToken || null;
      } else {
        throw err;
      }
    }

    // Process and upsert events
    for (const event of events) {
      if (!event.id || !event.start) continue;

      const startTime = event.start.dateTime || event.start.date;
      const endTime = event.end?.dateTime || event.end?.date;
      if (!startTime || !endTime) continue;

      // Extract attendees
      const attendees = event.attendees?.map((a: any) => ({
        email: a.email,
        name: a.displayName || a.email,
        responseStatus: a.responseStatus || "needsAction",
      })) || [];

      // Extract Meet link
      const meetLink = event.conferenceData?.entryPoints?.find(
        (ep: any) => ep.entryPointType === "video"
      )?.uri || null;

      // Check if private
      const isPrivate = event.visibility === "private" || event.visibility === "confidential";

      // Match attendees to contacts
      const attendeeEmails = attendees
        .map((a: any) => a.email)
        .filter((e: string) => e !== conn.data.gmail_address);

      let contactId: number | null = null;
      const contactIds: number[] = [];

      if (attendeeEmails.length > 0) {
        const { data: matched } = await service
          .from("contact_emails")
          .select("contact_id")
          .in("email", attendeeEmails);

        if (matched) {
          const uniqueIds = [...new Set(matched.map((m: any) => m.contact_id))];
          contactIds.push(...uniqueIds);
          contactId = uniqueIds[0] || null;
        }
      }

      // Upsert calendar event
      const { error: upsertErr } = await service.from("calendar_events").upsert({
        user_id: user.id,
        google_event_id: event.id,
        calendar_id: "primary",
        title: isPrivate ? null : (event.summary || null),
        description: isPrivate ? null : (event.description || null),
        start_at: new Date(startTime).toISOString(),
        end_at: new Date(endTime).toISOString(),
        all_day: !event.start.dateTime,
        location: event.location || null,
        meet_link: meetLink,
        status: event.status || null,
        attendees,
        is_private: isPrivate,
        recurring_event_id: event.recurringEventId || null,
        contact_id: contactId,
        synced_at: new Date().toISOString(),
      });

      if (upsertErr) {
        console.error("Error upserting event:", upsertErr);
        continue;
      }

      // Upsert contact links
      if (contactIds.length > 0) {
        const { data: ceData } = await service
          .from("calendar_events")
          .select("id")
          .eq("google_event_id", event.id)
          .eq("user_id", user.id)
          .single();

        if (ceData) {
          for (const cid of contactIds) {
            await service.from("calendar_event_contacts").upsert({
              calendar_event_id: ceData.id,
              contact_id: cid,
            });
          }
        }
      }
    }

    // Handle cancelled events — these arrive with status "cancelled" and often
    // lack start/end fields, so they are skipped by the upsert loop above.
    // Explicitly delete them from the local cache.
    const cancelledGoogleIds = events
      .filter((e: any) => e.status === "cancelled" && e.id)
      .map((e: any) => e.id);

    if (cancelledGoogleIds.length > 0) {
      const { data: toDelete } = await service
        .from("calendar_events")
        .select("id")
        .eq("user_id", user.id)
        .in("google_event_id", cancelledGoogleIds);

      for (const row of toDelete || []) {
        await service.from("calendar_event_contacts").delete().eq("calendar_event_id", row.id);
        await service.from("calendar_events").delete().eq("id", row.id);
      }
    }

    // Update sync token and timestamp
    await service
      .from("gmail_connections")
      .update({
        calendar_sync_token: nextSyncToken,
        calendar_last_synced_at: new Date().toISOString(),
      })
      .eq("user_id", user.id);

    return {
      success: true,
      eventsSynced: events.length,
      nextSyncToken,
    };
  },
});
