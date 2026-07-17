import { withApiHandler, ApiError } from "@/lib/api-handler";
import { calendarSyncQuerySchema } from "@/lib/api-schemas";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { fetchCalendarEvents, getCalendarTimezone, getCalendarList, DEFAULT_TIMEZONE } from "@/lib/calendar";
import type { Json } from "@/lib/database.types";


const SYNC_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (auto-sync)
const SYNC_FORCE_COOLDOWN_MS = 5 * 1000; // 5 seconds (manual sync button)
const INITIAL_SYNC_PAST_DAYS = 7;
const SYNC_FUTURE_DAYS = 60;

function getSyncWindow(nowMs: number) {
  return {
    timeMin: new Date(nowMs - INITIAL_SYNC_PAST_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(nowMs + SYNC_FUTURE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * POST /api/calendar/sync
 * Syncs Google Calendar events to the local cache.
 * Supports incremental sync via sync tokens.
 * Rate-limited to prevent abuse.
 */
export const POST = withApiHandler({
  querySchema: calendarSyncQuerySchema,
  handler: async ({ user, query }) => {
    const nowMs = Date.now();
    const syncWindow = getSyncWindow(nowMs);
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

    const sinceLastMs = Date.now() - lastSynced;
    if (sinceLastMs < cooldown) {
      // CAR-149: every 429 carries Retry-After so clients back off exactly the
      // remaining cooldown instead of hammering. The DB cooldown itself stays.
      const retryAfterSec = Math.max(1, Math.ceil((cooldown - sinceLastMs) / 1000));
      throw new ApiError("Synced recently, try again later.", 429, undefined, {
        "Retry-After": String(retryAfterSec),
      });
    }

    // On first sync: fetch timezone and calendar list from Google
    if (!conn.data.calendar_last_synced_at) {
      try {
        const [tz, calList] = await Promise.all([
          getCalendarTimezone(user.id),
          getCalendarList(user.id),
        ]);
        const busyIds = calList
          .filter((c) => c.accessRole === "owner" || c.accessRole === "writer")
          .map((c) => c.id)
          .filter((id): id is string => Boolean(id));

        await service.from("gmail_connections").update({
          calendar_timezone: tz || DEFAULT_TIMEZONE,
          calendar_list: calList as unknown as Json,
          busy_calendar_ids: busyIds.length > 0 ? busyIds : ["primary"],
        }).eq("user_id", user.id);
      } catch (err) {
        console.error("Failed to fetch timezone/calendar list:", err);
      }
    }

    // Fetch events from Google Calendar
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
    let events: any[] = [];
    let nextSyncToken: string | null = null;

    try {
      const result = await fetchCalendarEvents(user.id, {
        syncToken: conn.data.calendar_sync_token,
        timeMin: syncWindow.timeMin,
        timeMax: syncWindow.timeMax,
      });
      events = result.events;
      nextSyncToken = result.nextSyncToken || null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
    } catch (err: any) {
      if (err.message === "SYNC_TOKEN_EXPIRED") {
        await service
          .from("gmail_connections")
          .update({ calendar_sync_token: null })
          .eq("user_id", user.id);
        const result = await fetchCalendarEvents(user.id, {
          timeMin: syncWindow.timeMin,
          timeMax: syncWindow.timeMax,
        });
        events = result.events;
        nextSyncToken = result.nextSyncToken || null;
      } else {
        throw err;
      }
    }

    // Process events as one batch: a constant number of Supabase calls per
    // chunk instead of 3-5 round trips per event (CAR-152 / R3.2).
    const ownAddress = (conn.data.gmail_address || "").toLowerCase();

    // Set when any persistence step below fails. The sync cursor must NOT
    // advance past events that never persisted — Google only sends deltas
    // after the stored token, so skipped events would be permanently absent
    // from the cache. Leaving the token untouched re-fetches the same delta
    // next run; every write here is idempotent, so the retry is safe.
    let syncIncomplete = false;

    // Cancelled events (recurring instances included) arrive as status
    // "cancelled" skeletons, often without start/end. They are excluded from
    // the upsert set — writing then deleting them would be wasted work.
    const cancelledGoogleIds: string[] = events
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      .filter((e: any) => e.status === "cancelled" && e.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      .map((e: any) => e.id);

    const upsertable = events.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      (e: any) =>
        e.id &&
        e.status !== "cancelled" &&
        (e.start?.dateTime || e.start?.date) &&
        (e.end?.dateTime || e.end?.date)
    );

    // Attendee emails are matched lowercased. Note: contact_emails.email may
    // still hold mixed-case values (several write paths store verbatim), so
    // this is an exact-on-lowercase match, not case-insensitive — a stored
    // mixed-case email will not match until the Gmail-ingestion ticket
    // normalizes the column at write time and backfills.
    const allAttendeeEmails = new Set<string>();
    for (const event of upsertable) {
      for (const a of event.attendees || []) {
        const email = a.email?.toLowerCase();
        if (email && email !== ownAddress) allAttendeeEmails.add(email);
      }
    }

    // Scope the match to THIS user's contacts. contact_emails has no user_id
    // column, so an unscoped service-client match is global across all tenants
    // and would write a foreign contact_id onto this user's calendar rows
    // (CAR-133 / R2.1). Join through contacts.user_id, exactly like
    // activateContactByEmail in src/lib/gmail.ts. One query per email chunk —
    // .in() rides the request URL, so keep chunks well under URL limits.
    // One email can legitimately belong to several of this user's contacts
    // (the unique index is (contact_id, email) — shared team inboxes,
    // duplicate contacts), so the map accumulates ALL contact ids per email;
    // collapsing to one would silently drop links the per-event code wrote
    // before this rewrite.
    const contactIdsByEmail = new Map<string, number[]>();
    const emailList = [...allAttendeeEmails];
    for (let i = 0; i < emailList.length; i += 200) {
      const { data: matched } = await service
        .from("contact_emails")
        .select("contact_id, email, contacts!inner(user_id)")
        .in("email", emailList.slice(i, i + 200))
        .eq("contacts.user_id", user.id);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      for (const m of (matched as any[]) || []) {
        if (!m.email) continue;
        const key = m.email.toLowerCase();
        const list = contactIdsByEmail.get(key) ?? [];
        if (!list.includes(m.contact_id)) list.push(m.contact_id);
        contactIdsByEmail.set(key, list);
      }
    }

    // Build all rows up front; contactIdsByGoogleId feeds the link upserts.
    const contactIdsByGoogleId = new Map<string, number[]>();
    const syncedAt = new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
    const rowByGoogleId = new Map<string, any>();

    for (const event of upsertable) {
      const startTime = event.start.dateTime || event.start.date;
      const endTime = event.end.dateTime || event.end.date;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
      const attendees = event.attendees?.map((a: any) => ({
        email: a.email,
        name: a.displayName || a.email,
        responseStatus: a.responseStatus || "needsAction",
      })) || [];

      const meetLink = event.conferenceData?.entryPoints?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
        (ep: any) => ep.entryPointType === "video"
      )?.uri || null;

      const isPrivate = event.visibility === "private" || event.visibility === "confidential";

      const matchedIds: number[] = (event.attendees || [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CAR-142: any-debt inventory; resolve at typed-Supabase-boundary rollout
        .flatMap((a: any) => (a.email ? contactIdsByEmail.get(a.email.toLowerCase()) ?? [] : []));
      const contactIds = [...new Set(matchedIds)];
      contactIdsByGoogleId.set(event.id, contactIds);

      // Duplicate ids within one batch (an event updated twice across pages)
      // must collapse before the bulk upsert — Postgres rejects ON CONFLICT
      // touching the same row twice. Map insertion keeps the LAST occurrence.
      rowByGoogleId.set(event.id, {
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
        contact_id: contactIds[0] ?? null,
        synced_at: syncedAt,
      });
    }

    const rows = [...rowByGoogleId.values()];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);

      // Upsert on the (user_id, google_event_id) natural key: the row carries no
      // bigserial id, so a default (PK) conflict target INSERTs every time and
      // trips the unique constraint (23505), silently dropping event edits
      // (CAR-113). .select() returns the ids, replacing the per-event re-select.
      const { data: upserted, error: upsertErr } = await service
        .from("calendar_events")
        .upsert(chunk, { onConflict: "user_id,google_event_id" })
        .select("id, google_event_id");

      if (upsertErr) {
        console.error("Error upserting events:", upsertErr);
        syncIncomplete = true;
        continue;
      }

      const linkRows: Array<{ calendar_event_id: number; contact_id: number }> = [];
      for (const row of upserted || []) {
        for (const cid of contactIdsByGoogleId.get(row.google_event_id) || []) {
          linkRows.push({ calendar_event_id: row.id, contact_id: cid });
        }
      }

      if (linkRows.length > 0) {
        const { error: linkErr } = await service
          .from("calendar_event_contacts")
          .upsert(linkRows, { onConflict: "calendar_event_id,contact_id" });
        if (linkErr) {
          console.error("Error upserting event contact links:", linkErr);
          syncIncomplete = true;
        }
      }
    }

    // Delete cancelled events from the local cache. Chunked like the email
    // match — a deleted recurring series arrives as one cancelled skeleton
    // per occurrence under singleEvents, so this list can run to hundreds of
    // long ids, and .in() rides the request URL.
    if (cancelledGoogleIds.length > 0) {
      const deleteIds: number[] = [];
      for (let i = 0; i < cancelledGoogleIds.length; i += 200) {
        const { data: toDelete, error: lookupErr } = await service
          .from("calendar_events")
          .select("id")
          .eq("user_id", user.id)
          .in("google_event_id", cancelledGoogleIds.slice(i, i + 200));

        if (lookupErr) {
          console.error("Error looking up cancelled events:", lookupErr);
          syncIncomplete = true;
          continue;
        }
        deleteIds.push(...(toDelete || []).map((row) => row.id));
      }

      for (let i = 0; i < deleteIds.length; i += 200) {
        const chunk = deleteIds.slice(i, i + 200);
        const { error: linkDelErr } = await service
          .from("calendar_event_contacts")
          .delete()
          .in("calendar_event_id", chunk);
        const { error: eventDelErr } = await service
          .from("calendar_events")
          .delete()
          .in("id", chunk);
        if (linkDelErr || eventDelErr) {
          console.error("Error deleting cancelled events:", linkDelErr || eventDelErr);
          syncIncomplete = true;
        }
      }
    }

    // Advance the sync cursor only when every write above succeeded; on a
    // partial failure keep the old token so the next run re-fetches the same
    // delta (see syncIncomplete above). The timestamp still updates so the
    // cooldown paces retries.
    await service
      .from("gmail_connections")
      .update(
        syncIncomplete
          ? { calendar_last_synced_at: new Date().toISOString() }
          : {
              calendar_sync_token: nextSyncToken,
              calendar_last_synced_at: new Date().toISOString(),
            }
      )
      .eq("user_id", user.id);

    return {
      success: true,
      eventsSynced: events.length,
      nextSyncToken,
    };
  },
});
