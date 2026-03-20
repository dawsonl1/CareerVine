/**
 * Google Calendar API service module
 *
 * Handles Calendar OAuth token management (reuses gmail_connections tokens),
 * calendar event fetching, syncing, and free/busy queries.
 */

import { google } from "googleapis";
import { createSupabaseServiceClient } from "@/lib/supabase/service-client";
import { getOAuth2Client, refreshTokenIfNeeded } from "@/lib/oauth-helpers";

export const DEFAULT_TIMEZONE = "America/New_York";

/**
 * Merge overlapping or adjacent busy intervals into a minimal set.
 * Input intervals must have ISO string start/end properties.
 */
export function mergeBusyIntervals(intervals: Array<{ start: string; end: string }>) {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (new Date(current.start).getTime() <= new Date(last.end).getTime()) {
      last.end = new Date(
        Math.max(new Date(last.end).getTime(), new Date(current.end).getTime())
      ).toISOString();
    } else {
      merged.push(current);
    }
  }
  return merged;
}

/**
 * Load tokens from DB, refresh if expired, return an authenticated Calendar client.
 * Reuses the same gmail_connections row as Gmail — tokens are shared.
 */
export async function getCalendarClient(userId: string) {
  const supabase = createSupabaseServiceClient();

  const { data: conn, error } = await supabase
    .from("gmail_connections")
    .select("access_token, refresh_token, token_expires_at, calendar_scopes_granted")
    .eq("user_id", userId)
    .single();

  if (error || !conn) throw new Error("Calendar not connected");
  if (!conn.calendar_scopes_granted) throw new Error("Calendar scopes not granted");

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({
    access_token: conn.access_token,
    refresh_token: conn.refresh_token,
    expiry_date: new Date(conn.token_expires_at).getTime(),
  });

  await refreshTokenIfNeeded(supabase, oauth2Client, userId, new Date(conn.token_expires_at).getTime(), "Calendar");

  return google.calendar({ version: "v3", auth: oauth2Client });
}

/**
 * Get the user's Google Calendar timezone setting.
 * Called on first Calendar connect to store the authoritative timezone.
 */
export async function getCalendarTimezone(userId: string): Promise<string> {
  try {
    const calendar = await getCalendarClient(userId);
    const res = await calendar.settings.get({ setting: "timezone" });
    return res.data.value || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Fetch the user's calendar list (primary + secondary calendars).
 * Returns array of { id, summary, accessRole, ... }
 */
export async function getCalendarList(userId: string) {
  try {
    const calendar = await getCalendarClient(userId);
    const res = await calendar.calendarList.list();
    return res.data.items || [];
  } catch (err) {
    console.error("Error fetching calendar list:", err);
    return [];
  }
}

/**
 * Fetch events from Google Calendar API with pagination and sync token support.
 * Returns { events, nextSyncToken }
 */
export async function fetchCalendarEvents(
  userId: string,
  options: {
    syncToken?: string | null;
    timeMin?: string;
    timeMax?: string;
    calendarId?: string;
  } = {}
) {
  const calendar = await getCalendarClient(userId);
  const calendarId = options.calendarId || "primary";

  const params: any = {
    calendarId,
    maxResults: 250,
  };

  if (options.syncToken) {
    params.syncToken = options.syncToken;
  } else {
    if (options.timeMin) params.timeMin = options.timeMin;
    if (options.timeMax) params.timeMax = options.timeMax;
  }

  try {
    const res = await calendar.events.list(params);
    const events = res.data.items || [];
    const nextSyncToken = res.data.nextSyncToken;

    return { events, nextSyncToken };
  } catch (err: any) {
    if (err.code === 410) {
      // Sync token expired — clear it and do a full re-fetch
      throw new Error("SYNC_TOKEN_EXPIRED");
    }
    throw err;
  }
}

/**
 * Query free/busy information across multiple calendars.
 * Returns merged busy intervals for the specified calendars and time range.
 */
export async function queryFreeBusy(
  userId: string,
  options: {
    timeMin: string;
    timeMax: string;
    calendarIds: string[];
    timeZone: string;
  }
) {
  const calendar = await getCalendarClient(userId);

  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        timeZone: options.timeZone,
        items: options.calendarIds.map(id => ({ id })),
      },
    });

    // Merge busy intervals across all calendars
    const allBusyIntervals: Array<{ start: string; end: string }> = [];
    for (const calId of options.calendarIds) {
      const busy = res.data.calendars?.[calId]?.busy || [];
      allBusyIntervals.push(
        ...busy.filter((b): b is { start: string; end: string } => !!b.start && !!b.end)
      );
    }

    // Sort and merge overlapping intervals
    return mergeBusyIntervals(allBusyIntervals);
  } catch (err) {
    console.error("Error querying free/busy:", err);
    return [];
  }
}

/**
 * Create a Google Calendar event with optional Google Meet conference.
 * Returns the created event with its Google event ID and meet link (if applicable).
 */
export async function createCalendarEvent(
  userId: string,
  options: {
    summary: string;
    description?: string;
    startTime: string; // ISO 8601
    endTime: string;   // ISO 8601
    attendeeEmails?: string[];
    conferenceType?: "meet" | "zoom" | "none";
    timeZone?: string;
    calendarId?: string;
  }
) {
  const calendar = await getCalendarClient(userId);
  const calendarId = options.calendarId || "primary";

  const requestBody: any = {
    summary: options.summary,
    description: options.description || "",
    start: { dateTime: options.startTime, timeZone: options.timeZone || DEFAULT_TIMEZONE },
    end: { dateTime: options.endTime, timeZone: options.timeZone || DEFAULT_TIMEZONE },
  };

  if (options.attendeeEmails && options.attendeeEmails.length > 0) {
    requestBody.attendees = options.attendeeEmails.map(email => ({ email }));
  }

  if (options.conferenceType === "meet") {
    requestBody.conferenceData = {
      createRequest: {
        requestId: `${Date.now()}-${Math.random()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }

  try {
    const res = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: options.conferenceType === "meet" ? 1 : 0,
      requestBody,
    });

    const event = res.data;
    const meetLink = event.conferenceData?.entryPoints?.find(ep => ep.entryPointType === "video")?.uri;

    return {
      googleEventId: event.id!,
      meetLink: meetLink || null,
      event,
    };
  } catch (err) {
    console.error("Error creating calendar event:", err);
    throw err;
  }
}

/**
 * Update an existing Google Calendar event.
 */
export async function updateCalendarEvent(
  userId: string,
  googleEventId: string,
  options: {
    summary?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    calendarId?: string;
  }
) {
  const calendar = await getCalendarClient(userId);
  const calendarId = options.calendarId || "primary";

  try {
    const event = await calendar.events.get({ calendarId, eventId: googleEventId });
    const updated = event.data;

    if (options.summary) updated.summary = options.summary;
    if (options.description) updated.description = options.description;
    if (options.startTime) updated.start = { dateTime: options.startTime };
    if (options.endTime) updated.end = { dateTime: options.endTime };

    const res = await calendar.events.update({
      calendarId,
      eventId: googleEventId,
      requestBody: updated,
    });

    return res.data;
  } catch (err) {
    console.error("Error updating calendar event:", err);
    throw err;
  }
}

/**
 * Delete a Google Calendar event.
 */
export async function deleteCalendarEvent(
  userId: string,
  googleEventId: string,
  calendarId: string = "primary"
) {
  const calendar = await getCalendarClient(userId);

  try {
    await calendar.events.delete({ calendarId, eventId: googleEventId });
  } catch (err) {
    console.error("Error deleting calendar event:", err);
    throw err;
  }
}
