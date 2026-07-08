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

function rangeToWindow(range: "today" | "week" | "month" | undefined, start?: string, end?: string) {
  if (start || end) {
    if (!start || !end) throw new Error("Provide both start and end for a custom range");
    return { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString() };
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
        start: z.string().describe("Start time (ISO)"),
        end: z.string().describe("End time (ISO)"),
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
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw new Error("Invalid start/end timestamp");
      }
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

      const activated = await activateContactIfDormant(contact.id);
      return {
        summary: `Meeting "${title}" created with ${contact.name}${attendeeEmails.length ? " (invite sent)" : ""}${activated ? " — graduated into the active network" : ""}`,
        google_event_id: result.googleEventId,
        meet_link: result.meetLink,
        warnings,
      };
    }),
  );
}
