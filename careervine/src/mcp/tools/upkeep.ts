/**
 * Relationship-upkeep tools (plan 26, tools 20–25).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveContact,
  logInteraction,
  createActionItem,
  listActionItems,
  updateActionItem,
  listDueFollowUps,
  getNetworkHealth,
} from "../lib/db";
import { handler, contactRefShape } from "../lib/tool-utils";
import {
  logInteractionOutput,
  createActionItemOutput,
  listActionItemsOutput,
  listDueFollowupsOutput,
  getNetworkHealthOutput,
} from "../lib/output-schemas";
import { dueDateKey } from "@/lib/due-date";
import {
  CONVERSATION_TYPE_DETAIL_MAX_LENGTH,
  CONVERSATION_TYPE_VALUES,
  conversationTypeLabel,
  normalizeConversationTypeDetail,
} from "@/lib/constants";

/** UI wording ("todo" / "waiting_on") ↔ DB values ("my_task" / "waiting_on"). */
const directionToDb = { todo: "my_task", waiting_on: "waiting_on" } as const;

export function registerUpkeepTools(server: McpServer): void {
  server.registerTool(
    "log_interaction",
    {
      title: "Log interaction",
      description:
        "Record a touchpoint with a contact (career-fair, networking, coffee, text, other). This is a real relationship touch, so it graduates prospects/archived contacts into the active network and resets their follow-up clock. Use 'coffee' for ANY one-on-one conversation including phone and video calls; use 'other' with `detail` for anything the five do not cover.",
      inputSchema: {
        ...contactRefShape,
        // Derived from the shared vocabulary, never hand-listed (CAR-242): the
        // previous enum was a fourth independent list and had already drifted
        // from its own description. `email` is excluded because the send path
        // writes it, not callers.
        type: z.enum(CONVERSATION_TYPE_VALUES),
        detail: z
          .string()
          .max(CONVERSATION_TYPE_DETAIL_MAX_LENGTH)
          .optional()
          .describe("Free text describing the conversation. Only used when type is 'other'; ignored otherwise."),
        date: z.string().optional().describe("ISO timestamp; defaults to now"),
        summary: z.string().optional().describe("What was discussed"),
      },
      outputSchema: logInteractionOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, type, detail, date, summary }) => {
      const contact = await resolveContact({ contact_id, name });
      const when = date ? new Date(date) : new Date();
      if (Number.isNaN(when.getTime())) throw new Error(`Invalid date: ${date}`);
      // Drops a detail sent alongside a non-'other' type, which the
      // interactions_interaction_type_detail_check CHECK would reject.
      const typeDetail = normalizeConversationTypeDetail(type, detail);
      const result = await logInteraction(contact.id, type, typeDetail, when.toISOString(), summary ?? null);
      return {
        summary: `Logged ${conversationTypeLabel(type, typeDetail)} with ${contact.name}${result.activated ? ". Graduated into the active network" : ""}`,
        interaction_id: result.interactionId,
      };
    }),
  );

  server.registerTool(
    "create_action_item",
    {
      title: "Create action item",
      description:
        "Create a to-do (or a waiting-on item for something a contact owes you), optionally linked to one or more contacts with a due date.",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        due_at: z.string().min(1).optional().describe("Due date, YYYY-MM-DD"),
        direction: z
          .enum(["todo", "waiting_on"])
          .optional()
          .describe("todo (default) = my task; waiting_on = the contact owes me something"),
        contact_ids: z.array(z.number().int()).optional(),
        contact_names: z.array(z.string()).optional(),
      },
      outputSchema: createActionItemOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ title, description, due_at, direction, contact_ids, contact_names }) => {
      const ids = [...(contact_ids ?? [])];
      for (const n of contact_names ?? []) {
        ids.push((await resolveContact({ name: n })).id);
      }
      const itemId = await createActionItem({
        title,
        description,
        due_at,
        direction: directionToDb[direction ?? "todo"],
        contactIds: [...new Set(ids)],
      });
      return { summary: `Action item created (id ${itemId})`, action_item_id: itemId };
    }),
  );

  server.registerTool(
    "list_action_items",
    {
      title: "List action items",
      description:
        "Open action items with linked contacts. Filter by due window, direction (todo vs waiting-on), or contact. Waiting-on items include how long they've been outstanding.",
      inputSchema: {
        due: z.enum(["overdue", "today", "week", "all"]).optional().describe("Default: all"),
        direction: z.enum(["todo", "waiting_on"]).optional(),
        ...contactRefShape,
      },
      outputSchema: listActionItemsOutput,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ due, direction, contact_id, name }) => {
      let scopedContactId: number | undefined;
      if (contact_id != null || name) {
        scopedContactId = (await resolveContact({ contact_id, name })).id;
      }
      const items = await listActionItems({
        due,
        direction: direction ? directionToDb[direction] : undefined,
        contactId: scopedContactId,
      });
      const now = Date.now();
      return {
        summary: `${items.length} open action item(s)`,
        items: items.map((i) => ({
          action_item_id: i.id,
          title: i.title,
          description: i.description,
          // The calendar date, not the stored midnight-UTC instant, so what an
          // agent reads back is exactly what it can write again (CAR-206).
          due_at: dueDateKey(i.due_at),
          direction: i.direction === "waiting_on" ? "waiting_on" : "todo",
          age_days: i.created_at ? Math.floor((now - new Date(i.created_at).getTime()) / 86400_000) : null,
          contacts: i.action_item_contacts.map((c) => c.contacts).filter(Boolean),
        })),
      };
    }),
  );

  server.registerTool(
    "update_action_item",
    {
      title: "Update action item",
      description: "Complete, snooze, reschedule, or edit an action item.",
      inputSchema: {
        action_item_id: z.number().int(),
        complete: z.boolean().optional().describe("true marks it done"),
        snooze_until: z.string().optional().describe("ISO timestamp to hide it until"),
        // .min(1): an empty string must not read as "clear it". Only an explicit null
        // clears; "" is rejected here and would throw in normalizeDueDate anyway.
        due_at: z.string().min(1).nullable().optional().describe("New due date as YYYY-MM-DD, or null to clear"),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async ({ action_item_id, complete, snooze_until, due_at, title, description }) => {
      await updateActionItem(action_item_id, { complete, snooze_until, due_at, title, description });
      return { summary: `Action item ${action_item_id} updated${complete ? " (completed)" : ""}` };
    }),
  );

  server.registerTool(
    "list_due_followups",
    {
      title: "List due follow-ups",
      description:
        "Contacts past their follow-up cadence (the home-page reach-out list): who's overdue, by how many days, never-contacted flags, and whether an email address is on file. Most-overdue first.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      },
      outputSchema: listDueFollowupsOutput,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ limit }) => {
      const due = await listDueFollowUps();
      const page = due.slice(0, limit ?? 50);
      return {
        summary: `${due.length} contact(s) due for follow-up${page.length < due.length ? `; showing the ${page.length} most overdue` : ""}`,
        contacts: page,
      };
    }),
  );

  server.registerTool(
    "get_network_health",
    {
      title: "Get network health",
      description:
        "How am I doing? Networking streak, relationships-on-track ratio, most-neglected contacts (with the full count, so you can tell a short list from a short tail), per-tier counts, and last-30-day activity totals.",
      inputSchema: {
        neglected_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many neglected contacts to list (default 15). neglectedTotal always reports the real count."),
      },
      outputSchema: getNetworkHealthOutput,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ neglected_limit }) => getNetworkHealth(neglected_limit)),
  );
}
