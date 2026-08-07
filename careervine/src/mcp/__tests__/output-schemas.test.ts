import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { createRecordingClient, type RecordedQuery } from "./helpers/recording-client";
import { mockServiceClientModule } from "@/__tests__/helpers/mock-supabase";
import { mockAnalyticsServerModule } from "@/__tests__/helpers/mock-analytics";
import { runWithUserAsync } from "@/mcp/user-context";
import { registerOutreachTools } from "@/mcp/tools/outreach";
import { registerContactTools } from "@/mcp/tools/contacts";
import { registerEmailTools } from "@/mcp/tools/email";
import { registerUpkeepTools } from "@/mcp/tools/upkeep";
import { registerCalendarTools } from "@/mcp/tools/calendar";
import { TOOLS_WITHOUT_OUTPUT_SCHEMA } from "@/mcp/lib/output-schemas";
import { ok } from "@/mcp/lib/tool-utils";

/**
 * CAR-272. `outputSchema` is a runtime contract, not documentation: the SDK
 * throws when a tool declares one and returns no `structuredContent`, and
 * throws again when the content fails to parse. A schema that does not match
 * its handler is therefore an outage, not a docs bug.
 *
 * So this file does two things:
 *
 *  1. **Ledger.** Every registered tool either declares a schema or is named in
 *     `TOOLS_WITHOUT_OUTPUT_SCHEMA`. A new tool that does neither fails here,
 *     so the gap stays visible instead of becoming the default.
 *  2. **Truth.** For each tool that DOES declare one, drive the real handler and
 *     parse the real payload with the declared schema. Without this the schema
 *     is a guess that only fails in production.
 */

const state = vi.hoisted(() => ({
  recorded: [] as unknown[],
  route: (() => undefined) as (q: unknown) => unknown,
  nextId: 100,
}));

vi.mock("@/lib/supabase/service-client", () =>
  mockServiceClientModule(() => createRecordingClient(state as Parameters<typeof createRecordingClient>[0])),
);
vi.mock("@/lib/analytics/server", () =>
  mockAnalyticsServerModule({ trackServer: async () => {}, checkContactMilestone: async () => {} }),
);

// Gmail and Calendar are the only reason 12 of these tools were exempted in the
// first draft. Both are network clients behind a module seam, so a stub at the
// seam is all that was ever needed — the "requires a fake" framing was wrong.
vi.mock("@/lib/gmail", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGmailClient: async () => ({}),
  createGmailDraft: async () => ({ draftId: "d-1", gmailUrl: "https://mail.google.com/d-1" }),
  getFullMessage: async () => ({ messageId: "<m-1>", body: "hello", headers: {} }),
  sendGmailMessage: async () => ({ messageId: "m-1", threadId: "t-1" }),
}));
vi.mock("@/lib/email-send", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTrackedEmail: async () => ({ messageId: "m-1", threadId: "t-1", sendsRemainingToday: 42 }),
}));
vi.mock("@/lib/capabilities", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCapabilities: async () => new Set(["drafts:gmail", "mailbox:read", "send:gmail", "schedule:send"]),
}));
vi.mock("@/lib/calendar", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCalendarEvent: async () => ({ googleEventId: "g-1", meetLink: "https://meet.google.com/x" }),
}));

const USER = "user-schemas";
/** Far enough ahead that schedule_email's "must be future" check passes. */
const FUTURE_ISO = "2027-01-15T17:00:00.000Z";

interface Registered {
  name: string;
  outputSchema?: Record<string, z.ZodTypeAny>;
  handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean }>;
}

/** Register every tool against a fake server and capture name + schema + handler. */
function allTools(): Registered[] {
  const tools: Registered[] = [];
  const fake = {
    registerTool: (name: string, config: { outputSchema?: Record<string, z.ZodTypeAny> }, handler: never) => {
      tools.push({ name, outputSchema: config?.outputSchema, handler });
    },
  } as never;
  registerContactTools(fake);
  registerEmailTools(fake);
  registerOutreachTools(fake);
  registerUpkeepTools(fake);
  registerCalendarTools(fake);
  return tools;
}

const CONTACT = { id: 5, name: "Jane Doe", network_status: "prospect", stage_override: null };
const TARGET = { id: 21, location_id: null, is_targeted: true, active_cycle: 1, status: "applied" };
// target_company_id must match the id the target_companies fixture yields for
// company 1000 (5000), or loadPipeline finds no cycle and the append throws.
const CYCLE = { id: 31, target_company_id: 5000, cycle_number: 1, selected_stage: "applied", declined_next_cycle: false };
const COMPANY_IDS = [1000, 1001, 1002];

/**
 * Fixtures for every tool's happy path.
 *
 * SELECTS ONLY. Returning a row for an insert would shadow the recording
 * client's auto-id, which is how `add_contact` came back with an undefined
 * contact_id and looked like a schema bug rather than a fixture one.
 */
function route(q: RecordedQuery): unknown {
  if (q.op !== "select" && !q.rpc) return undefined;
  // A .maybeSingle()/.single() read wants an object; handing it the array form
  // is how "no target company with id N" appears for a fixture that clearly
  // defines one.
  const one = (rows: unknown[]) =>
    q.resolution === "maybeSingle" || q.resolution === "single" ? (rows[0] ?? null) : rows;

  switch (q.table) {
    case "users": return { university: "BYU", timezone: "America/Denver" };
    case "gmail_connections": return { id: 1, user_id: USER, email: "me@acme.com", scopes: "full" };
    case "contacts":
      return q.resolution === "maybeSingle" || q.resolution === "single"
        ? CONTACT
        : [{
            ...CONTACT, industry: "SaaS", headline: "PM at Acme",
            contact_emails: [{ email: "jane@acme.com", is_primary: true, source: "verified", bounced_at: null }],
            contact_companies: [{ title: "PM", is_current: true, start_month: null, end_month: null, companies: { name: "Acme" } }],
            contact_schools: [{ schools: { name: "BYU" } }],
            contact_tags: [{ tags: { name: "VIP" } }],
          }];
    case "companies":
      return q.resolution === "maybeSingle" || q.resolution === "single"
        ? { id: 1000, name: "Acme" }
        : COMPANY_IDS.map((id) => ({ id, name: `Company ${id}`, logo_url: null, linkedin_url: null }));
    case "target_companies": {
      const rows = COMPANY_IDS.map((company_id, i) => ({
        ...TARGET, id: 5000 + i, company_id, priority_score: 10 - i,
        program_name: null, app_window_text: null, next_app_date: null, status: "researching", locations: null,
      }));
      // Honour a company_id filter. Without this, a single-company read returns
      // all three rows, they all carry location_id null so they collapse onto
      // the same "all" scope key, and the last one wins — which presents as
      // "company has no cycle 1" rather than as a broken fixture.
      const wanted = q.filters.find(([m, c]) => m === "eq" && c === "company_id")?.[2];
      return one(wanted != null ? rows.filter((r) => r.company_id === wanted) : rows);
    }
    case "rpc:company_network_counts":
      return COMPANY_IDS.map((company_id) => ({
        company_id, current_count: 2, former_count: 1, bench_count: 0, current_prospect_count: 2,
      }));
    case "contact_companies":
      return [{
        company_id: 1000, contact_id: 50, is_current: true, id: 1, title: "PM",
        start_month: null, end_month: null, location_id: null, workplace_type: null, locations: null,
        contacts: {
          id: 50, user_id: USER, name: "Person", network_status: "prospect", stage_override: null,
          persona: "product_peer", verified_school: null, photo_url: null, headline: null,
          review_note: null, last_scraped_at: null, import_meta: null, linkedin_url: null,
        },
      }];
    case "pipeline_cycles": return one([CYCLE]);
    case "pipeline_applications":
    case "pipeline_notes":
    case "pipeline_interview_rounds":
    case "pipeline_programs": return [];
    case "contact_emails": return one([{ id: 31, contact_id: 5, email: "jane@acme.com", is_primary: true, source: "verified", bounced_at: null }]);
    case "contact_phones": return [];
    case "contact_schools": return [];
    case "contact_tags": return [];
    case "tags": return one([{ id: 77, name: "VIP" }]);
    case "interactions": return [];
    case "meetings": return [];
    case "meeting_contacts": return [];
    case "referrals": return [];
    case "calendar_events": return [];
    case "calendar_event_contacts": return [];
    case "follow_up_action_items":
      return q.resolution === "maybeSingle" || q.resolution === "single"
        ? { id: 61, user_id: USER, title: "Send deck", description: null, due_at: null, direction: "todo", completed_at: null, created_at: "2026-08-01T00:00:00Z" }
        : [{ id: 61, user_id: USER, title: "Send deck", description: null, due_at: null, direction: "todo", completed_at: null, created_at: "2026-08-01T00:00:00Z", follow_up_action_item_contacts: [] }];
    case "action_item_contacts": return [];
    case "email_messages":
      return [{
        id: 81, user_id: USER, gmail_message_id: "gm-1", thread_id: "t-1", subject: "Intro",
        snippet: "hello", from_address: "jane@acme.com", to_addresses: ["me@acme.com"],
        date: "2026-08-01T00:00:00Z", direction: "outbound", matched_contact_id: 5, is_simulated: false,
      }];
    case "email_message_contacts": return [];
    case "scheduled_emails":
      return q.resolution === "maybeSingle" || q.resolution === "single"
        ? { id: 91, user_id: USER, recipient_email: "jane@acme.com", subject: "Hi", scheduled_send_at: FUTURE_ISO, thread_id: "t-1", contact_name: "Jane Doe", matched_contact_id: 5, status: "pending" }
        : [{ id: 91, user_id: USER, recipient_email: "jane@acme.com", subject: "Hi", scheduled_send_at: FUTURE_ISO, thread_id: "t-1", contact_name: "Jane Doe", matched_contact_id: 5, status: "pending" }];
    case "email_follow_ups":
      return q.resolution === "maybeSingle" || q.resolution === "single"
        ? { id: 71, user_id: USER, status: "active", recipient_email: "jane@acme.com", contact_name: "Jane Doe", original_subject: "Hi", thread_id: "t-1", original_sent_at: "2026-08-01T00:00:00Z" }
        : [{ id: 71, user_id: USER, status: "active", recipient_email: "jane@acme.com", contact_name: "Jane Doe", original_subject: "Hi", thread_id: "t-1", original_sent_at: "2026-08-01T00:00:00Z", email_follow_up_messages: [{ id: 72, sequence_number: 1, subject: "Bump", status: "pending", scheduled_send_at: FUTURE_ISO }] }];
    case "email_follow_up_messages":
      return [{ id: 72, follow_up_id: 71, sequence_number: 1, subject: "Bump", body_html: "<p>Bump</p>", status: "pending", scheduled_send_at: FUTURE_ISO }];
    default: return undefined;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.recorded.length = 0;
  state.route = route as (q: unknown) => unknown;
});

/** Arguments that reach each schema-bearing handler's success path. */
const DRIVE_ARGS: Record<string, Record<string, unknown>> = {
  list_outreach_queue: { limit: 5 },
  list_companies: { limit: 5 },
  get_company: { company_id: 1000 },
  get_company_pipeline: { company_id: 1000 },
  set_company_stage: { company_id: 1000, stage: "interviewing" },
  update_company_target: { company_id: 1000, next_app_date: "2026-10-01" },
  log_application: { company_id: 1000, job_title: "APM" },
  log_interview_round: { company_id: 1000, interviewer: "Ada" },
  update_contact: { contact_id: 5, industry: "SaaS" },
  add_contact_email: { contact_id: 5, email: "new@acme.com" },
  add_contact_phone: { contact_id: 5, phone: "555-0100" },
  untag_contact: { contact_id: 5, tags: ["VIP"] },
  defer_follow_up: { contact_id: 5, until: "2026-09-01T00:00:00.000Z" },
  // Contacts
  search_contacts: { query: "jane" },
  get_contact_dossier: { contact_id: 5 },
  add_contact: { name: "New Person" },
  add_contact_note: { contact_id: 5, note: "met at a fair" },
  tag_contact: { contact_id: 5, tags: ["VIP"] },
  set_network_status: { contact_id: 5, status: "active" },
  add_company_intel: { company_id: 1000, note: "apps open in Sept" },
  set_stage_override: { contact_id: 5, stage: "contacted" },
  // Upkeep
  log_interaction: { contact_id: 5, type: "coffee" },
  create_action_item: { title: "Send deck" },
  list_action_items: {},
  update_action_item: { action_item_id: 61, complete: true },
  list_due_followups: { limit: 5 },
  get_network_health: {},
  // Email
  create_email_draft: { contact_id: 5, subject: "Hi", body: "Hello" },
  send_email: { contact_id: 5, subject: "Hi", body: "Hello", confirm: true },
  schedule_email: { contact_id: 5, subject: "Hi", body: "Hello", send_at: FUTURE_ISO },
  create_follow_up_sequence: {
    contact_id: 5, thread_id: "t-1",
    messages: [{ subject: "Bump", body: "Following up", send_after_days: 3 }],
  },
  list_scheduled: {},
  cancel_scheduled: { scheduled_email_id: 91 },
  reschedule_follow_up: { follow_up_id: 71, send_time: "09:00" },
  search_email_history: { query: "intro" },
  check_delivery: { since_days: 7 },
  get_email_thread: { thread_id: "t-1" },
  // Calendar
  list_meetings: { range: "week" },
  create_meeting: {
    contact_id: 5, title: "Coffee",
    start: "2026-09-01T15:00:00.000Z", end: "2026-09-01T15:30:00.000Z",
  },
};

describe("output schema ledger", () => {
  it("every tool either declares a schema or is a named exemption", () => {
    const unaccounted = allTools()
      .filter((t) => !t.outputSchema && !(t.name in TOOLS_WITHOUT_OUTPUT_SCHEMA))
      .map((t) => t.name);

    // A new tool must make a deliberate choice. Silence would let the gap grow
    // back invisibly, which is the state this ticket found.
    expect(unaccounted, `add an outputSchema or a TOOLS_WITHOUT_OUTPUT_SCHEMA entry for: ${unaccounted.join(", ")}`).toEqual([]);
  });

  it("the exemption list names only tools that exist", () => {
    const names = new Set(allTools().map((t) => t.name));
    const stale = Object.keys(TOOLS_WITHOUT_OUTPUT_SCHEMA).filter((n) => !names.has(n));
    expect(stale, `remove these stale exemptions: ${stale.join(", ")}`).toEqual([]);
  });

  it("every schema-bearing tool has a drive, so none is declared unverified", () => {
    const undriven = allTools()
      .filter((t) => t.outputSchema && !(t.name in DRIVE_ARGS))
      .map((t) => t.name);
    expect(undriven, `these declare a schema with nothing driving it: ${undriven.join(", ")}`).toEqual([]);
  });
});

describe("declared schemas match what the handlers actually return", () => {
  const schemaBearing = allTools().filter((t) => t.outputSchema);

  it("covers most of the surface, and the count only goes up", () => {
    // A ratchet. 30 of 39 tools carry a verified contract; lowering this means
    // a tool lost one, which should be a deliberate act with a reason.
    expect(schemaBearing.length).toBeGreaterThanOrEqual(30);
  });

  for (const tool of schemaBearing) {
    it(`${tool.name}: real payload parses`, async () => {
      const res = await runWithUserAsync(USER, () => tool.handler(DRIVE_ARGS[tool.name]));
      // A thrown handler would make this vacuous — the SDK skips validation on
      // isError, so a failing drive would "pass" without checking anything.
      expect(res.isError, `handler errored: ${res.content[0]?.text}`).toBeFalsy();
      expect(res.structuredContent, "no structuredContent — the SDK would throw").toBeTruthy();

      const parsed = z.object(tool.outputSchema!).safeParse(res.structuredContent);
      expect(
        parsed.success,
        parsed.success ? "" : `${tool.name} output does not match its schema: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    });
  }
});

describe("ok()", () => {
  it("keeps the text block first and adds structured content", () => {
    const res = ok({ summary: "hi", n: 1 });
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect(JSON.parse(res.content[0].text)).toEqual({ summary: "hi", n: 1 });
    expect(res.structuredContent).toEqual({ summary: "hi", n: 1 });
  });

  it("does not promote arrays or primitives, which are not valid structured content", () => {
    expect(ok([1, 2]).structuredContent).toBeUndefined();
    expect(ok("plain").structuredContent).toBeUndefined();
    expect(ok(null).structuredContent).toBeUndefined();
  });
});
