import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { fetchCalendarEvents, getCalendarTimezone, getCalendarList } from "@/lib/calendar";


const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const SYNC_FORCE_COOLDOWN_MS = 30 * 1000; // 30 seconds for forced syncs

/**
 * POST /api/calendar/sync
 * Syncs Google Calendar events to the local cache.
 * Supports incremental sync via sync tokens.
 * Rate-limited to prevent abuse.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (!user || authError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const service = createSupabaseServiceClient();
    const conn = await service
      .from("gmail_connections")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (!conn.data || !conn.data.calendar_scopes_granted) {
      return NextResponse.json({ error: "Calendar not connected" }, { status: 400 });
    }

    // Rate limiting
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true";
    const lastSynced = conn.data.calendar_last_synced_at
      ? new Date(conn.data.calendar_last_synced_at).getTime()
      : 0;
    const cooldown = force ? SYNC_FORCE_COOLDOWN_MS : SYNC_COOLDOWN_MS;

    if (Date.now() - lastSynced < cooldown) {
      return NextResponse.json(
        { skipped: true, message: "Synced recently, try again later." },
        { status: 429 }
      );
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
          calendar_timezone: tz || "America/New_York",
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
        timeMax: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      });
      events = result.events;
      nextSyncToken = result.nextSyncToken || null;
    } catch (err: any) {
      if (err.message === "SYNC_TOKEN_EXPIRED") {
        // Clear token and retry with full fetch
        await service
          .from("gmail_connections")
          .update({ calendar_sync_token: null })
          .eq("user_id", user.id);
        const result = await fetchCalendarEvents(user.id, {
          timeMin: new Date().toISOString(),
          timeMax: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
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

    // Handle cancelled events
    const { data: existingEvents } = await service
      .from("calendar_events")
      .select("id, google_event_id")
      .eq("user_id", user.id);

    const eventIds = new Set(events.map((e: any) => e.id));
    for (const existing of existingEvents || []) {
      if (!eventIds.has(existing.google_event_id)) {
        // Check if it was cancelled in the sync
        const cancelled = events.find((e: any) => e.id === existing.google_event_id && e.status === "cancelled");
        if (cancelled) {
          await service.from("calendar_events").delete().eq("id", existing.id);
        }
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

    return NextResponse.json({
      success: true,
      eventsSynced: events.length,
      nextSyncToken,
    });
  } catch (error) {
    console.error("Calendar sync error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}
