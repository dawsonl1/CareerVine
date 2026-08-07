/**
 * Declared response shapes for the MCP tools (CAR-272).
 *
 * ── Read this before adding one ──────────────────────────────────────────
 *
 * An `outputSchema` here is NOT documentation. `@modelcontextprotocol/sdk`'s
 * `validateToolOutput` throws `McpError` when a tool declares a schema and
 * returns no `structuredContent`, and throws again when the content fails to
 * parse. So a schema that does not match what the handler actually returns
 * converts a working tool into a hard runtime error for every caller,
 * including an agent already connected.
 *
 * Two rules follow, and both are enforced by `output-schemas.test.ts`:
 *
 *  1. **A tool declares a schema only if a test drives its real handler and
 *     parses the real payload with it.** Tools without that coverage are listed
 *     in `TOOLS_WITHOUT_OUTPUT_SCHEMA` — visible, named work rather than a
 *     silent gap.
 *  2. **`required` means the handler sets it unconditionally.** A field that is
 *     only sometimes present must be `.optional()`. Marking a conditional field
 *     required is precisely how this feature becomes an outage.
 *
 * Unknown keys are fine: zod objects ignore extras when parsing, and the SDK
 * only checks that parsing succeeds. So adding a field to a handler cannot
 * break its tool — only changing or removing a DECLARED one can.
 */

import { z } from "zod";

/** Every tool response leads with a human-readable line. */
const summary = z.string();

/** `{count, at}` — how many, and how recently. Null when nothing was measured. */
const tally = z.object({ count: z.number(), at: z.string().nullable() }).nullable();

const targetBlock = z
  .object({
    target_id: z.number().optional(),
    priority_score: z.number().nullable().optional(),
    program_name: z.string().nullable().optional(),
    next_app_date: z.string().nullable().optional(),
    app_window_text: z.string().nullable().optional(),
    status: z.string().optional(),
  })
  .nullable();

/** The base company row, present whether or not the enrichment pass ran. */
const companyBase = z.object({
  company_id: z.number(),
  name: z.string(),
  linkedin_url: z.string().nullable().optional(),
  current_count: z.number(),
  former_count: z.number(),
  bench_count: z.number(),
  target: targetBlock.optional(),
});

/**
 * The enriched row. `traction` and the alumni counts are OPTIONAL, not
 * nullable-required: `list_companies(targets_only:false)` omits them entirely
 * rather than sending zeroes, which is the whole point of CAR-262. A schema
 * demanding them would make that scope throw.
 */
const companyEnriched = companyBase.extend({
  traction: z.string().nullable().optional(),
  traction_detail: tally.optional(),
  alum_count: z.number().optional(),
  product_alum_count: z.number().optional(),
  recruiter_count: z.number().optional(),
  lead_contact_name: z.string().nullable().optional(),
});

export const listCompaniesOutput = {
  summary,
  traction_included: z.boolean(),
  companies: z.array(companyEnriched),
};

export const listOutreachQueueOutput = {
  summary,
  boost_window_days: z.number(),
  queue: z.array(companyEnriched.extend({ position: z.number(), why: z.string() })),
};

const person = z.object({
  contact_id: z.number(),
  name: z.string(),
  headline: z.string().nullable().optional(),
  persona: z.string().nullable().optional(),
  network_tier: z.string().optional(),
  is_alum: z.boolean().optional(),
  stage: z.string().nullable().optional(),
  email: z
    .object({ address: z.string(), source: z.string(), bounced: z.boolean() })
    .nullable()
    .optional(),
  review_note: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  selection_reason: z.string().nullable().optional(),
  adjacency_score: z.number().nullable().optional(),
  last_interaction: z.object({ type: z.string(), date: z.string() }).nullable().optional(),
  last_scraped_at: z.string().nullable().optional(),
  current_position: z
    .object({ title: z.string().nullable(), company_id: z.number(), company_name: z.string() })
    .nullable()
    .optional(),
  roles: z.array(z.object({}).passthrough()).optional(),
});

export const getCompanyOutput = {
  summary,
  company: z.object({}).passthrough(),
  target: z.object({}).passthrough().nullable(),
  offices: z.array(z.object({}).passthrough()),
  office_facets: z.array(z.object({}).passthrough()).optional(),
  current: z.array(person),
  former: z.array(person),
  archived_imports: z.array(person),
  counts: z.object({ current: z.number(), former: z.number(), archived: z.number() }),
};

export const getCompanyPipelineOutput = {
  summary,
  company_id: z.number(),
  scopes: z.array(
    z.object({
      scope: z.string(),
      scope_label: z.string(),
      location_id: z.number().nullable(),
      target_id: z.number(),
      is_targeted: z.boolean(),
      target_status: z.string().nullable(),
      active_cycle: z.number(),
      cycle_count: z.number(),
      cycles: z.array(
        z.object({
          cycle_number: z.number(),
          stage: z.string(),
          declined_next_cycle: z.boolean(),
          programs: z.array(z.object({}).passthrough()),
          notes: z.array(z.string()),
          applications: z.array(z.object({}).passthrough()),
          interview_rounds: z.array(z.object({}).passthrough()),
        }),
      ),
    }),
  ),
};

// ── Writes ───────────────────────────────────────────────────────────────
//
// Each returns the summary plus the ids a caller needs to act again without
// re-resolving. `fields` is the list actually written, which is what makes a
// partial update auditable.

export const updateContactOutput = {
  summary,
  contact_id: z.number(),
  fields: z.array(z.string()),
};

export const addContactDetailOutput = { summary, contact_id: z.number() };

export const untagContactOutput = { summary, removed: z.array(z.string()) };

export const deferFollowUpOutput = { summary, contact_id: z.number() };

export const setCompanyStageOutput = { summary, company_id: z.number() };

export const updateCompanyTargetOutput = {
  summary,
  company_id: z.number(),
  fields: z.array(z.string()),
};

export const logApplicationOutput = {
  summary,
  company_id: z.number(),
  application_id: z.string(),
};

export const logInterviewRoundOutput = {
  summary,
  company_id: z.number(),
  round_id: z.string(),
};

/**
 * Tools that deliberately ship WITHOUT an output schema, and why.
 *
 * Not an oversight list and not permanent: every entry is a tool whose handler
 * has no test fixture driving it yet, and rule 1 above says a schema without
 * that coverage is a liability rather than a contract. `output-schemas.test.ts`
 * fails if a tool is neither here nor schema-bearing, so this cannot rot into
 * an invisible gap.
 */
export const TOOLS_WITHOUT_OUTPUT_SCHEMA: Record<string, string> = {
  // Gmail-backed: driving these needs a Gmail fake, not a query fixture.
  create_email_draft: "needs a Gmail fake to drive",
  send_email: "needs a Gmail fake to drive",
  schedule_email: "needs a Gmail fake to drive",
  create_follow_up_sequence: "needs a Gmail fake to drive",
  list_scheduled: "needs a Gmail fake to drive",
  cancel_scheduled: "needs a Gmail fake to drive",
  reschedule_follow_up: "needs a Gmail fake to drive",
  search_email_history: "needs a Gmail fake to drive",
  check_delivery: "needs a Gmail fake to drive",
  get_email_thread: "hydrates every message through live Gmail",
  // Calendar-backed: same, via the Google Calendar client.
  list_meetings: "needs a Calendar fake to drive",
  create_meeting: "needs a Calendar fake to drive",
  // Contact reads/writes whose fixtures land with the dossier harness.
  search_contacts: "no driving fixture yet",
  get_contact_dossier: "no driving fixture yet",
  add_contact: "no driving fixture yet",
  add_contact_note: "no driving fixture yet",
  tag_contact: "no driving fixture yet",
  set_network_status: "no driving fixture yet",
  // Upkeep.
  log_interaction: "no driving fixture yet",
  create_action_item: "no driving fixture yet",
  list_action_items: "no driving fixture yet",
  update_action_item: "no driving fixture yet",
  list_due_followups: "no driving fixture yet",
  get_network_health: "no driving fixture yet",
  // Outreach leftovers.
  add_company_intel: "no driving fixture yet",
  set_stage_override: "no driving fixture yet",
};
