/**
 * Relationship-upkeep tools (plan 26, tools 20–25).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveContact,
  logInteraction,
  editInteraction,
  createActionItem,
  listActionItems,
  updateActionItem,
  listDueFollowUps,
  getNetworkHealth,
} from "../lib/db";
import { handler, contactRefShape } from "../lib/tool-utils";
import { dueDateKey } from "@/lib/due-date";
import {
  CONVERSATION_TYPE_DETAIL_MAX_LENGTH,
  CONVERSATION_TYPE_VALUES,
  conversationTypeLabel,
  normalizeConversationTypeDetail,
} from "@/lib/constants";

/** UI wording ("todo" / "waiting_on") ↔ DB values ("my_task" / "waiting_on"). */
const directionToDb = { todo: "my_task", waiting_on: "waiting_on" } as const;

/**
 * Patch shape for `update_interaction` (CAR-275). Every field is optional and
 * absent means unchanged, so a caller can fix one thing without restating the
 * row.
 *
 * The destination contact is `move_to_contact_*` rather than the usual
 * `contact_id` / `name` on purpose. Everywhere else on this server those two
 * identify the SUBJECT of the call; here the subject is `interaction_id` and
 * the contact is a destination, and reusing the names for an inverted meaning
 * is the kind of thing a model gets wrong in exactly the direction that
 * silently rewrites the wrong row.
 */
export const updateInteractionSchema = {
  interaction_id: z
    .number()
    .int()
    .describe("From get_contact_dossier's interactions.shown[].id, or log_interaction's return value"),
  move_to_contact_id: z.number().int().optional().describe("Reassign the interaction to this contact"),
  move_to_contact_name: z
    .string()
    .optional()
    .describe("Reassign by name — exact or partial; ambiguous matches return candidates with ids"),
  // Same five as log_interaction, from the shared vocabulary rather than a
  // hand-listed enum (CAR-242). `email` is absent for the same reason it is
  // there: the send path writes it, callers do not.
  type: z.enum(CONVERSATION_TYPE_VALUES).optional(),
  detail: z
    .string()
    .max(CONVERSATION_TYPE_DETAIL_MAX_LENGTH)
    .nullable()
    .optional()
    .describe("Free text describing the conversation. Only used when the type is 'other'; cleared otherwise."),
  date: z.string().optional().describe("ISO timestamp"),
  summary: z.string().nullable().optional().describe("What was discussed, or null to clear it"),
  excluded: z
    .boolean()
    .optional()
    .describe(
      "true drops this interaction from every calculation (last touch, streaks, network health, outreach stage) while leaving it in the record; false puts it back. This is how you retract a mistake, since nothing here deletes.",
    ),
};

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
    "update_interaction",
    {
      title: "Update interaction",
      description:
        "Correct an interaction that was already logged: change its type, detail, date or summary, move it to a different contact, or set excluded to drop it from every calculation while leaving it in the record. Every field is optional and only what you pass changes. Get ids from get_contact_dossier. Interactions the email send path wrote describe a real sent message, so only their summary and excluded can change.",
      inputSchema: updateInteractionSchema,
      annotations: { readOnlyHint: false },
    },
    handler(
      async ({ interaction_id, move_to_contact_id, move_to_contact_name, type, detail, date, summary, excluded }) => {
        const moving = move_to_contact_id != null || Boolean(move_to_contact_name?.trim());
        // An empty patch is a malformed call, not a no-op. Reporting success
        // for a write that touched nothing is how an agent concludes it fixed
        // something and moves on.
        if (
          !moving &&
          type === undefined &&
          detail === undefined &&
          date === undefined &&
          summary === undefined &&
          excluded === undefined
        ) {
          throw new Error(
            "Nothing to update. Pass at least one of move_to_contact_id, move_to_contact_name, type, detail, date, summary, or excluded.",
          );
        }

        // Resolved here rather than inside editInteraction because the name is
        // what the response reports back; editInteraction asserts the id again
        // for its own integrity.
        const destination = moving
          ? await resolveContact({ contact_id: move_to_contact_id, name: move_to_contact_name })
          : undefined;

        let when: string | undefined;
        if (date !== undefined) {
          const parsed = new Date(date);
          if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${date}`);
          when = parsed.toISOString();
        }

        const { previous, activated } = await editInteraction(interaction_id, {
          contactId: destination?.id,
          type,
          detail,
          date: when,
          summary,
          excluded,
        });

        // Reported field by field so a caller can confirm the edit landed the
        // way it meant, rather than trusting a bare "updated".
        const changes: string[] = [];
        if (destination && destination.id !== previous.contact_id) changes.push(`moved to ${destination.name}`);
        if (type !== undefined || detail !== undefined) {
          const nextType = type ?? previous.interaction_type;
          const nextDetail = detail !== undefined ? detail : previous.interaction_type_detail;
          changes.push(`type is now ${conversationTypeLabel(nextType, normalizeConversationTypeDetail(nextType, nextDetail))}`);
        }
        if (when) changes.push(`dated ${when}`);
        if (summary !== undefined) changes.push(summary === null ? "summary cleared" : "summary updated");
        if (excluded !== undefined) {
          changes.push(
            excluded
              ? "removed from every calculation, still in the record"
              : "restored to every calculation",
          );
        }
        if (changes.length === 0) changes.push("no change (already as requested)");

        return {
          summary: `Interaction ${interaction_id}: ${changes.join("; ")}${activated ? ". Graduated into the active network" : ""}`,
          interaction_id,
          contact_id: destination?.id ?? previous.contact_id,
          activated,
        };
      },
    ),
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
      annotations: { readOnlyHint: true },
    },
    handler(async ({ neglected_limit }) => getNetworkHealth(neglected_limit)),
  );
}
