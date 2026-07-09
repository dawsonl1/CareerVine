/**
 * Contacts & research tools (plan 26, tools 1–6).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getContactStages } from "@/lib/company-queries";
import {
  uid,
  resolveContact,
  fetchSearchRows,
  buildLastTouchMap,
  getDossierBundle,
  createContactFull,
  appendNote,
  tagContact,
  setNetworkStatus,
  type SearchRow,
} from "../lib/db";
import { buildDossier } from "../lib/dossier";
import { handler, contactRefShape } from "../lib/tool-utils";

export const searchContactsSchema = {
  query: z.string().min(1).describe("Matches name, email, company, job title, school, industry, or tag"),
  tiers: z
    .array(z.enum(["active", "prospect", "bench"]))
    .optional()
    .describe("Limit to network tiers (active = my network, bench = archive). Default: all"),
  limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
};

export const dossierSchema = {
  ...contactRefShape,
  depth: z
    .enum(["recent", "full"])
    .optional()
    .describe("recent (default) = last 10 interactions/emails/meetings with totals; full = everything"),
};

export const addContactSchema = {
  name: z.string().min(1),
  industry: z.string().optional(),
  linkedin_url: z.string().optional(),
  notes: z.string().optional(),
  met_through: z.string().optional(),
  follow_up_frequency_days: z.number().int().positive().optional(),
  network_status: z.enum(["active", "prospect", "bench"]).optional().describe("Default: active"),
  emails: z.array(z.string()).optional().describe("First entry becomes primary"),
  phones: z.array(z.object({ phone: z.string(), type: z.string().optional() })).optional(),
  company: z
    .object({ name: z.string(), title: z.string().optional(), is_current: z.boolean().optional() })
    .optional(),
  school: z
    .object({ name: z.string(), degree: z.string().optional(), field_of_study: z.string().optional() })
    .optional(),
  location: z
    .object({ city: z.string().optional(), state: z.string().optional(), country: z.string() })
    .optional(),
};

export const addNoteSchema = {
  ...contactRefShape,
  note: z.string().min(1).describe("Appended to the contact's notes with a timestamp"),
};

export const tagContactSchema = {
  ...contactRefShape,
  tags: z.array(z.string().min(1)).min(1).describe("Tag names — created if they don't exist"),
};

export const setNetworkStatusSchema = {
  ...contactRefShape,
  status: z
    .enum(["active", "prospect", "bench"])
    .describe("active = my network, prospect = outreach pool, bench = archive"),
};

function matchesQuery(row: SearchRow, q: string): boolean {
  const fields = [
    row.name,
    row.headline,
    row.industry,
    ...row.contact_emails.map((e) => e.email),
    ...row.contact_companies.flatMap((cc) => [cc.title, cc.companies?.name]),
    ...row.contact_schools.map((s) => s.schools?.name),
    ...row.contact_tags.map((t) => t.tags?.name),
  ];
  return fields.some((f) => f && f.toLowerCase().includes(q));
}

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description:
        "Search the CareerVine network by name, email, company, job title, school, industry, or tag. Returns compact rows with id, current role, tier, derived outreach stage, days since last touch, and primary email (with provenance flags).",
      inputSchema: searchContactsSchema,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ query, tiers, limit }) => {
      const q = query.trim().toLowerCase();
      const rows = await fetchSearchRows(tiers);
      const matches = rows.filter((r) => matchesQuery(r, q)).slice(0, limit ?? 10);

      const [stages, lastTouch] = await Promise.all([
        getContactStages(uid(), matches.map((m) => ({ id: m.id, stage_override: m.stage_override }))),
        buildLastTouchMap(matches.map((m) => m.id)),
      ]);
      const now = Date.now();

      const results = matches.map((m) => {
        const current = m.contact_companies.find((cc) => cc.is_current);
        const usable = m.contact_emails.filter((e) => e.email);
        const primary = usable.find((e) => e.is_primary) ?? usable[0];
        const touched = lastTouch.get(m.id);
        return {
          contact_id: m.id,
          name: m.name,
          headline: m.headline,
          company: current?.companies?.name ?? null,
          title: current?.title ?? null,
          network_tier: m.network_status,
          outreach_stage: stages.get(m.id)?.stage ?? null,
          last_touch_days_ago: touched ? Math.floor((now - new Date(touched).getTime()) / 86400_000) : null,
          primary_email: primary
            ? { email: primary.email, source: primary.source, bounced: primary.bounced_at != null }
            : null,
        };
      });
      return { summary: `${results.length} contact(s) match "${query}"`, results };
    }),
  );

  server.registerTool(
    "get_contact_dossier",
    {
      title: "Get contact dossier",
      description:
        "Everything known about one contact in a single structured document: identity, tier + derived outreach stage, cadence and last touch, work history, education (alum flag), emails with provenance (verified / pattern-guessed / bounced), notes, tags, open and completed action items, interactions, meetings, cached email history, and pending scheduled sends. Use this as grounding before writing an email.",
      inputSchema: dossierSchema,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ contact_id, name, depth }) => {
      const contact = await resolveContact({ contact_id, name });
      const bundle = await getDossierBundle(contact.id, depth ?? "recent");
      const stages = await getContactStages(uid(), [
        { id: contact.id, stage_override: contact.stage_override },
      ]);
      return buildDossier(bundle, stages.get(contact.id)?.stage ?? null);
    }),
  );

  server.registerTool(
    "add_contact",
    {
      title: "Add contact",
      description:
        "Create a new contact with optional emails, phones, current company + title, school, and location. Companies, schools, and locations are find-or-created so no duplicate entities are introduced.",
      inputSchema: addContactSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async (input) => {
      const contactId = await createContactFull(input);
      return { summary: `Created contact ${input.name} (id ${contactId})`, contact_id: contactId };
    }),
  );

  server.registerTool(
    "add_contact_note",
    {
      title: "Add contact note",
      description: "Append a timestamped note to a contact's notes field.",
      inputSchema: addNoteSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, note }) => {
      const contact = await resolveContact({ contact_id, name });
      await appendNote(contact.id, note);
      return { summary: `Note added to ${contact.name}` };
    }),
  );

  server.registerTool(
    "tag_contact",
    {
      title: "Tag contact",
      description: "Apply one or more tags to a contact (tags are created if they don't exist yet).",
      inputSchema: tagContactSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, tags }) => {
      const contact = await resolveContact({ contact_id, name });
      const applied = await tagContact(contact.id, tags);
      return { summary: `Tagged ${contact.name}: ${applied.join(", ")}` };
    }),
  );

  server.registerTool(
    "set_network_status",
    {
      title: "Set network tier",
      description:
        "Move a contact between tiers: active (my network), prospect (outreach pool), or bench (archive). Note: replies, logged interactions, and meeting links graduate prospects to active automatically — use this only for manual moves.",
      inputSchema: setNetworkStatusSchema,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, status }) => {
      const contact = await resolveContact({ contact_id, name });
      const { previous } = await setNetworkStatus(contact.id, status);
      return { summary: `${contact.name}: ${previous} → ${status}` };
    }),
  );
}
