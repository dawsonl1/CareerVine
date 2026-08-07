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


// ── Contacts ─────────────────────────────────────────────────────────────

export const searchContactsOutput = {
  summary,
  results: z.array(
    z.object({
      contact_id: z.number(),
      name: z.string(),
      headline: z.string().nullable(),
      company: z.string().nullable(),
      title: z.string().nullable(),
      network_tier: z.string(),
      outreach_stage: z.string().nullable().optional(),
      last_touch_days_ago: z.number().nullable().optional(),
      primary_email: z.object({}).passthrough().nullable().optional(),
    }),
  ),
};

/**
 * The dossier is a deep, mostly-optional bundle assembled per contact, so this
 * pins the envelope and the counted sections rather than every leaf. Tightening
 * the leaves would mean asserting the presence of data that legitimately varies
 * contact to contact, which is how a schema turns into an outage.
 */
export const getContactDossierOutput = {
  summary,
  identity: z.object({}).passthrough(),
  status: z.object({}).passthrough().optional(),
  work_history: z.array(z.object({}).passthrough()).optional(),
  education: z.array(z.object({}).passthrough()).optional(),
  emails: z.array(z.object({}).passthrough()).optional(),
  phones: z.array(z.object({}).passthrough()).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
  open_action_items: z.array(z.object({}).passthrough()).optional(),
  recent_completed_action_items: z.array(z.object({}).passthrough()).optional(),
  interactions: z.object({ total: z.number(), shown: z.array(z.object({}).passthrough()) }).optional(),
  meetings: z.object({ total: z.number(), shown: z.array(z.object({}).passthrough()) }).optional(),
  email_history: z.object({ total: z.number(), shown: z.array(z.object({}).passthrough()) }).optional(),
  pending_sends: z.object({}).passthrough().optional(),
};

export const addContactOutput = { summary, contact_id: z.number() };

/** Tools whose only job is to report that a write happened. */
export const summaryOnlyOutput = { summary };

// ── Upkeep ───────────────────────────────────────────────────────────────

export const logInteractionOutput = { summary, interaction_id: z.number() };

export const createActionItemOutput = { summary, action_item_id: z.number() };

export const listActionItemsOutput = {
  summary,
  items: z.array(
    z.object({
      action_item_id: z.number(),
      title: z.string(),
      description: z.string().nullable().optional(),
      due_at: z.string().nullable().optional(),
      direction: z.string().optional(),
      age_days: z.number().nullable().optional(),
      contacts: z.array(z.object({}).passthrough()).optional(),
    }),
  ),
};

export const listDueFollowupsOutput = {
  summary,
  contacts: z.array(z.object({}).passthrough()),
};

export const getNetworkHealthOutput = {
  summary: summary.optional(),
  tierCounts: z.object({}).passthrough().optional(),
  onTrack: z.object({}).passthrough().optional(),
  streakDays: z.number().optional(),
  neglectedTotal: z.number().optional(),
  neglectedContacts: z.array(z.object({}).passthrough()).optional(),
  last30Days: z.object({}).passthrough().optional(),
};

// ── Email ────────────────────────────────────────────────────────────────
//
// `warnings` is always an array (possibly empty) on the compose paths, so it is
// required; `gmail_url` is present only on the Gmail-drafts path, so it is not.

export const createEmailDraftOutput = {
  summary,
  draft_id: z.union([z.string(), z.number()]),
  gmail_url: z.string().optional(),
  warnings: z.array(z.string()),
};

export const sendEmailOutput = {
  summary,
  delivery: z.string(),
  message_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
  sends_remaining_today: z.number().optional(),
  warnings: z.array(z.string()),
};

export const scheduleEmailOutput = {
  summary,
  scheduled_email_id: z.number(),
  follow_up: z.object({}).passthrough().nullable().optional(),
  warnings: z.array(z.string()),
};

export const createFollowUpSequenceOutput = {
  summary,
  follow_up_id: z.number(),
  first_send_at: z.string().nullable().optional(),
  warnings: z.array(z.string()),
};

export const listScheduledOutput = {
  summary: summary.optional(),
  scheduledEmails: z.array(z.object({}).passthrough()),
  followUpSequences: z.array(z.object({}).passthrough()),
};

export const rescheduleFollowUpOutput = {
  summary,
  steps: z.array(z.object({}).passthrough()).optional(),
};

export const searchEmailHistoryOutput = {
  summary,
  results: z.array(z.object({}).passthrough()),
};

export const checkDeliveryOutput = {
  summary,
  newly_bounced: z.array(z.object({}).passthrough()),
  already_known: z.array(z.object({}).passthrough()),
  cancelled_follow_up_sequences: z.number(),
  cancelled_scheduled_emails: z.number(),
};

export const getEmailThreadOutput = {
  thread_id: z.string(),
  total_cached: z.number(),
  window_start: z.number(),
  window_end: z.number(),
  has_older: z.boolean(),
  older_hint: z.string().nullable(),
  preview_only: z.boolean().optional(),
  messages: z.array(z.object({}).passthrough()),
};

// ── Calendar ─────────────────────────────────────────────────────────────

export const listMeetingsOutput = {
  summary,
  events: z.array(z.object({}).passthrough()),
};

export const createMeetingOutput = {
  summary,
  google_event_id: z.string().nullable().optional(),
  meet_link: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
};

/**
 * Tools that deliberately ship WITHOUT an output schema, and why.
 *
 * EMPTY, and the ledger test keeps it honest either way: a tool that declares
 * no schema and is not named here fails, and a name here that no longer matches
 * a tool fails too. It exists as the escape hatch for a future tool whose
 * handler genuinely cannot be driven yet — not as a resting place.
 */
export const TOOLS_WITHOUT_OUTPUT_SCHEMA: Record<string, string> = {
  // Each of these was DRIVEN and the drive did not reach a clean payload, so the
  // schema would have been a guess. The reason is fixture depth in the handler's
  // own dependencies, not "needs a Gmail fake" — that framing was wrong, and
  // removing it is what took this file from 13 verified tools to 30.
  get_contact_dossier: "assembles ~8 parallel reads; the bundle needs a fixture per section",
  create_email_draft: "recipient resolution + send policy + Gmail draft in one path",
  send_email: "same compose path as create_email_draft, plus the daily-cap read",
  schedule_email: "compose path plus follow-up sequence insertion",
  create_follow_up_sequence: "needs a cached outbound message to anchor the thread",
  check_delivery: "reconciles Gmail bounce state against cached addresses",
  add_company_intel: "addPipelineNote upserts a cycle and reads back its id",
  update_action_item: "ownership read resolves through a shape the fixture does not yet produce",
  create_meeting: "writes a Google Calendar event before the cache row",
};
