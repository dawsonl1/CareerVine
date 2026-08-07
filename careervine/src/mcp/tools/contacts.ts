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
  untagContact,
  setNetworkStatus,
  updateContactFields,
  addContactEmail,
  addContactPhone,
  deferFollowUp,
  getViewerSchool,
} from "../lib/db";
import { buildDossier } from "../lib/dossier";
import { handler, contactRefShape } from "../lib/tool-utils";
import {
  updateContactOutput,
  addContactDetailOutput,
  untagContactOutput,
  deferFollowUpOutput,
  searchContactsOutput,
  addContactOutput,
  summaryOnlyOutput,
} from "../lib/output-schemas";
import { dateKeyOf, daysBetweenDateKeys, todayDateKey } from "@/lib/calendar-day";
import { primaryCurrentRole } from "@/lib/experience-order";
import { searchContacts } from "@/lib/contact-search";

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
    .object({
      city: z.string().optional(),
      state: z
        .string()
        .optional()
        .describe('Full US state name preferred (e.g. "California", not "CA") — normalized on save'),
      country: z.string(),
    })
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

/** CAR-265. Every field optional; the handler rejects an empty patch. */
export const updateContactSchema = {
  ...contactRefShape,
  industry: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional().describe("Canonicalized on write"),
  headline: z.string().nullable().optional().describe("A later scrape may overwrite this"),
  met_through: z.string().nullable().optional(),
  follow_up_frequency_days: z.number().int().min(1).max(3650).nullable().optional()
    .describe("Cadence in days; null clears it"),
  preferred_contact_method: z.string().nullable().optional(),
  preferred_contact_value: z.string().nullable().optional(),
  intro_goal: z.string().nullable().optional(),
};

export const addContactEmailSchema = {
  ...contactRefShape,
  email: z.string().min(3),
  is_primary: z.boolean().optional().describe("Defaults true when the contact has no address yet"),
  source: z.enum(["verified", "scraped", "pattern_guessed", "manual"]).optional(),
};

export const addContactPhoneSchema = {
  ...contactRefShape,
  phone: z.string().min(3),
  type: z.string().optional().describe("mobile (default), work, home"),
  is_primary: z.boolean().optional(),
};

export const untagContactSchema = {
  ...contactRefShape,
  tags: z.array(z.string()).min(1).describe("Tag names to unlink; the tags themselves are kept"),
};

export const deferFollowUpSchema = {
  ...contactRefShape,
  until: z.string().optional().describe("ISO date/time to snooze until"),
  skip_first_outreach: z.literal(true).optional()
    .describe("Permanently stop suggesting a FIRST outreach to this contact"),
};

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description:
        "Search the CareerVine network by name, email, company, job title, school, industry, or tag. Returns compact rows with id, current role, tier, derived outreach stage, days since last touch, and primary email (with provenance flags).",
      inputSchema: searchContactsSchema,
      outputSchema: searchContactsOutput,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ query, tiers, limit }) => {
      const rows = await fetchSearchRows(tiers);
      // Ranked, not first-N: `limit` used to truncate rows in load order, so an
      // exact name match could be cut while a tag match survived (CAR-222).
      const matches = searchContacts(rows, query).slice(0, limit ?? 10);

      const [stages, lastTouch] = await Promise.all([
        getContactStages(uid(), matches.map((m) => ({ id: m.id, stage_override: m.stage_override }))),
        buildLastTouchMap(matches.map((m) => m.id)),
      ]);

      const results = matches.map((m) => {
        const current = primaryCurrentRole(m.contact_companies);
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
          last_touch_days_ago: touched
            ? daysBetweenDateKeys(dateKeyOf(new Date(touched)), todayDateKey())
            : null,
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
        "Everything known about one contact in a single structured document: identity, tier + derived outreach stage, cadence and last touch, work history, education (alum flag, relative to your own school), emails with provenance (verified / pattern-guessed / bounced), notes, tags, open and completed action items, interactions, meetings, cached email history, and pending scheduled sends. Use this as grounding before writing an email.",
      inputSchema: dossierSchema,
      annotations: { readOnlyHint: true },
    },
    handler(async ({ contact_id, name, depth }) => {
      const contact = await resolveContact({ contact_id, name });
      const bundle = await getDossierBundle(contact.id, depth ?? "recent");
      const stages = await getContactStages(uid(), [
        { id: contact.id, stage_override: contact.stage_override },
      ]);
      // CAR-213: the alum flag is relative to the ACCOUNT HOLDER's school, so
      // the dossier has to know it. Null when they have claimed none, which
      // makes is_school_alum false and drops the alum line from the summary.
      const viewerSchool = await getViewerSchool(uid());
      return buildDossier(bundle, stages.get(contact.id)?.stage ?? null, new Date(), viewerSchool);
    }),
  );

  server.registerTool(
    "add_contact",
    {
      title: "Add contact",
      description:
        "Create a new contact with optional emails, phones, current company + title, school, and location. Companies, schools, and locations are find-or-created so no duplicate entities are introduced.",
      inputSchema: addContactSchema,
      outputSchema: addContactOutput,
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
      outputSchema: summaryOnlyOutput,
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
      outputSchema: summaryOnlyOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, tags }) => {
      const contact = await resolveContact({ contact_id, name });
      const applied = await tagContact(contact.id, tags);
      return { summary: `Tagged ${contact.name}: ${applied.join(", ")}` };
    }),
  );

  server.registerTool(
    "update_contact",
    {
      title: "Update contact",
      description:
        "Edit a contact's own fields: industry, LinkedIn URL, headline, how you met, follow-up cadence, preferred contact method, intro goal. Only the fields you pass are changed. Network tier is set_network_status, notes are add_contact_note, outreach stage is set_stage_override.",
      inputSchema: updateContactSchema,
      outputSchema: updateContactOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, ...patch }) => {
      const contact = await resolveContact({ contact_id, name });
      const changed = await updateContactFields(contact.id, patch);
      if (changed.length === 0) throw new Error("Pass at least one field to change");
      return { summary: `Updated ${contact.name}: ${changed.join(", ")}`, contact_id: contact.id, fields: changed };
    }),
  );

  server.registerTool(
    "add_contact_email",
    {
      title: "Add contact email",
      description:
        "Add an email address to an existing contact. The first address becomes primary automatically; marking a later one primary demotes the old one so the contact never has two.",
      inputSchema: addContactEmailSchema,
      outputSchema: addContactDetailOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, email, is_primary, source }) => {
      const contact = await resolveContact({ contact_id, name });
      const { demotedPrimaries } = await addContactEmail(contact.id, email, { isPrimary: is_primary, source });
      return {
        summary:
          `Added ${email} to ${contact.name}` +
          (demotedPrimaries > 0 ? ` (now primary; demoted ${demotedPrimaries})` : ""),
        contact_id: contact.id,
      };
    }),
  );

  server.registerTool(
    "add_contact_phone",
    {
      title: "Add contact phone",
      description: "Add a phone number to an existing contact.",
      inputSchema: addContactPhoneSchema,
      outputSchema: addContactDetailOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, phone, type, is_primary }) => {
      const contact = await resolveContact({ contact_id, name });
      await addContactPhone(contact.id, phone, { type, isPrimary: is_primary });
      return { summary: `Added ${phone} to ${contact.name}`, contact_id: contact.id };
    }),
  );

  server.registerTool(
    "untag_contact",
    {
      title: "Remove tags from contact",
      description:
        "Unlink tags from a contact. The tags themselves stay in the workspace for other contacts. Names not on the contact are reported back rather than treated as an error.",
      inputSchema: untagContactSchema,
      outputSchema: untagContactOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, tags }) => {
      const contact = await resolveContact({ contact_id, name });
      const removed = await untagContact(contact.id, tags);
      const missed = tags.filter((t) => !removed.some((r) => r.toLowerCase() === t.trim().toLowerCase()));
      return {
        summary:
          removed.length > 0
            ? `Removed from ${contact.name}: ${removed.join(", ")}` +
              (missed.length > 0 ? `; not on this contact: ${missed.join(", ")}` : "")
            : `No matching tags on ${contact.name}`,
        removed,
      };
    }),
  );

  server.registerTool(
    "defer_follow_up",
    {
      title: "Defer a follow-up",
      description:
        "Snooze a contact's follow-up until a date, or permanently stop suggesting a FIRST outreach to them. Both also set a three-week suggestion cooldown. Use this instead of leaving a due follow-up overdue.",
      inputSchema: deferFollowUpSchema,
      outputSchema: deferFollowUpOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, until, skip_first_outreach }) => {
      const contact = await resolveContact({ contact_id, name });
      const { action } = await deferFollowUp(contact.id, { until, skipFirstOutreach: skip_first_outreach });
      return {
        summary:
          action === "skipped"
            ? `${contact.name}: first outreach skipped`
            : `${contact.name}: snoozed until ${until}`,
        contact_id: contact.id,
      };
    }),
  );

  server.registerTool(
    "set_network_status",
    {
      title: "Set network tier",
      description:
        "Move a contact between tiers: active (my network), prospect (outreach pool), or bench (archive). Note: replies, logged interactions, and meeting links graduate prospects to active automatically — use this only for manual moves.",
      inputSchema: setNetworkStatusSchema,
      outputSchema: summaryOnlyOutput,
      annotations: { readOnlyHint: false },
    },
    handler(async ({ contact_id, name, status }) => {
      const contact = await resolveContact({ contact_id, name });
      const { previous } = await setNetworkStatus(contact.id, status);
      return { summary: `${contact.name}: ${previous} → ${status}` };
    }),
  );
}
