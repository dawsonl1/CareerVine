/**
 * Calendar tools (plan 26, tools 26–27). Reuses the app's Calendar
 * service module (shared gmail_connections tokens).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCalendarEvent } from "@/lib/calendar";
import {
  uid,
  resolveContact,
  getContactFull,
  listCalendarEvents,
  cacheCalendarEvent,
  activateContactIfDormant,
} from "../lib/db.ts";
import { resolveRecipient, type EmailRowLike } from "../lib/email-policy.ts";
import { handler, contactRefShape } from "../lib/tool-utils.ts";

/** Parse an ISO timestamp, requiring an explicit timezone offset so a naive
 *  time isn't silently interpreted in the MCP host's local zone. */
function parseInstant(label: string, iso: string): Date {
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso.trim())) {
    throw new Error(
      `${label} must include a timezone offset (e.g. "2026-07-10T15:00:00-06:00" or "...Z") so the time is unambiguous.`,
    );
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid ISO timestamp: ${iso}`);
  return d;
}

function rangeToWindow(range: "today" | "week" | "month" | undefined, start?: string, end?: string) {
  if (start || end) {
    if (!start || !end) throw new Error("Provide both start and end for a custom range");
    const min = new Date(start);
    const max = new Date(end);
    if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime())) {
      throw new Error("Custom range start/end must be valid ISO timestamps");
    }
    return { timeMin: min.toISOString(), timeMax: max.toISOString() };
  }
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  switch (range ?? "week") {
    case "today":
      to.setDate(to.getDate() + 1);
      break;
    case "week":
      to.setDate(to.getDate() + 7);
      break;
    case "month":
      to.setMonth(to.getMonth() + 1);
      break;
  }
  return { timeMin: from.toISOString(), timeMax: to.toISOString() };
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "list_meetings",
    {
      title: "List meetings",
      description:
        "Upcoming calendar events (from the synced Google Calendar cache) with attendees matched to CareerVine contacts. Range: today, week (default), month, or a custom start/end.",
      inputSchema: {
        range: z.enum(["today", "week", "month"]).optional(),
        start: z.string().optional().describe("Custom range start (ISO)"),
        end: z.string().optional().describe("Custom range end (ISO)"),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async ({ range, start, end }) => {
      const { timeMin, timeMax } = rangeToWindow(range, start, end);
      const events = await listCalendarEvents(timeMin, timeMax);
      return {
        summary: `${events.length} event(s) between ${timeMin.slice(0, 10)} and ${timeMax.slice(0, 10)}`,
        events: events.map((e) => ({
          google_event_id: e.google_event_id,
          title: e.title,
          start_at: e.start_at,
          end_at: e.end_at,
          meet_link: e.meet_link ?? e.zoom_link,
          attendees: ((e.attendees ?? []) as Array<{ email?: string; responseStatus?: string }>).map(
            (a) => ({ email: a.email, rsvp: a.responseStatus }),
          ),
          matched_contacts: e.matched_contacts,
        })),
      };
    }),
  );

  server.registerTool(
    "create_meeting",
    {
      title: "Create meeting",
      description:
        "Create a Google Calendar event with a contact — sends them a calendar invite (their primary email) and optionally attaches a Google Meet link. Linking a meeting is a real relationship touch, so it graduates prospects into the active network.",
      inputSchema: {
        ...contactRefShape,
        title: z.string().min(1),
        start: z.string().describe("Start time as ISO 8601 WITH a timezone offset, e.g. 2026-07-10T15:00:00-06:00 or ...Z"),
        end: z.string().describe("End time as ISO 8601 WITH a timezone offset (same format as start)"),
        description: z.string().optional().describe("Calendar invite description"),
        include_meet_link: z.boolean().optional().describe("Attach a Google Meet link (default true)"),
        send_invite: z
          .boolean()
          .optional()
          .describe("Add the contact as an attendee so Google emails them the invite (default true)"),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, title, start, end, description, include_meet_link, send_invite }) => {
      const startDate = parseInstant("start", start);
      const endDate = parseInstant("end", end);
      if (endDate <= startDate) throw new Error("end must be after start");

      const contact = await resolveContact({ contact_id, name });
      const warnings: string[] = [];
      let attendeeEmails: string[] = [];
      if (send_invite !== false) {
        const full = (await getContactFull(contact.id)) as unknown as { contact_emails: EmailRowLike[] };
        const recipient = resolveRecipient(contact.name, full.contact_emails);
        attendeeEmails = [recipient.email];
        warnings.push(...recipient.warnings);
      }

      const result = await createCalendarEvent(uid(), {
        summary: title,
        description,
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString(),
        attendeeEmails,
        conferenceType: include_meet_link === false ? "none" : "meet",
      });

      // The Google event now exists and the invite has already been sent — it
      // is the source of truth. If local caching or graduation fails, report a
      // SUCCESS with a warning rather than throwing: a thrown error would read
      // as "meeting not created" and prompt a retry that mints a second Google
      // event and a duplicate invite to the contact.
      let activated = false;
      try {
        await cacheCalendarEvent({
          googleEventId: result.googleEventId,
          title,
          description: description ?? null,
          startAt: startDate.toISOString(),
          endAt: endDate.toISOString(),
          meetLink: result.meetLink,
          attendeeEmails,
          contactId: contact.id,
        });
        activated = await activateContactIfDormant(contact.id);
      } catch (cacheErr) {
        warnings.push(
          `Meeting was created on Google Calendar but local sync failed (${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}). Do not recreate it — it will appear after the next calendar sync.`,
        );
      }
      return {
        summary: `Meeting "${title}" created with ${contact.name}${attendeeEmails.length ? " (invite sent)" : ""}${activated ? " — graduated into the active network" : ""}`,
        google_event_id: result.googleEventId,
        meet_link: result.meetLink,
        warnings,
      };
    }),
  );
}
