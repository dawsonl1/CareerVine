/**
 * The MCP scoping gate (CAR-151, retires audit finding F10).
 *
 * The MCP data layer runs with the service-role key (RLS bypassed), so every
 * query it can reach MUST hand-scope to the operating user. This suite is
 * table-driven:
 *
 *  1. Every value export of src/mcp/lib/db.ts and of every src/lib/data
 *     module has a classification entry. A NEW export without an entry fails
 *     (export enumeration), and a stale entry without an export fails too.
 *  2. Every MCP-consumable entry is driven through a recording query-builder
 *     client wired via the REAL injection path (initDb -> setDataClient /
 *     setCompanyQueriesClient), and every recorded operation must carry
 *     .eq(user_id) / an embedded *.user_id filter backed by an !inner embed /
 *     a user_id payload, hit a justified global table, or key exclusively on
 *     ids the same invocation PROVED it owns (a scoped read that returned the
 *     row, or a scoped mutation that matched it).
 *  3. Classifications marked web-only are enforced mechanically: no file
 *     under src/mcp may import them (fs scan, route-auth-inventory style).
 *
 * What this gate does and does not guarantee — read before trusting it.
 * It IS a regression detector for the scoping of the code paths it drives:
 * removing a user_id filter, or dropping an !inner from an embed that a
 * user_id filter depends on, fails the corresponding drive. It is NOT a proof
 * of tenant isolation. Its reach is bounded by three things, each of which has
 * bitten before (see the CAR-151 deep review, which found the original version
 * green under 7 of 8 hand-injected scoping regressions):
 *   - a function is only checked through the fixtures its drive supplies, so a
 *     code path the fixture never exercises is unverified (mcp-covered entries
 *     therefore declare `touches`, asserting the driver really reaches them);
 *   - `context` entries are not driven at all, so that classification is
 *     separately guarded against smuggling in queries;
 *   - the import closure is a source scan, not a call graph.
 * Extend the table when you add a surface; do not assume silence means safety.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fg from "fast-glob";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertAllScoped,
  GLOBAL_TABLES,
  type OwnershipSpec,
  type RecordedQuery,
  type RouteCtx,
} from "./helpers/recording-client";

const state = vi.hoisted(() => ({
  recorded: [] as unknown[],
  route: (() => undefined) as (q: unknown) => unknown,
  nextId: 100,
}));

vi.mock("@/lib/supabase/service-client", async () => {
  const { createRecordingClient } = await import("./helpers/recording-client");
  return {
    createSupabaseServiceClient: () =>
      createRecordingClient(state as Parameters<typeof createRecordingClient>[0]),
  };
});

// Analytics manage their own service client and swallow errors; keep them
// out of the recording so drive assertions cover only data-layer queries.
vi.mock("@/lib/analytics/server", () => ({
  trackServer: async () => {},
  checkContactMilestone: async () => {},
}));

import * as db from "@/mcp/lib/db";
import { getContactStages, getCompanies, getCompanyDetail } from "@/lib/company-queries";
import { getNeglectedContacts, getRelationshipsOnTrack } from "@/lib/data/follow-ups";
import { deriveDueFollowUps } from "@/lib/rules/due-follow-ups";
import { getNetworkingStreak as getStreakShared } from "@/lib/data/home";

const USER = "user-1";

// ── Shared fixtures ────────────────────────────────────────────────────

const CONTACT_CORE = { id: 5, name: "Jane", network_status: "prospect", stage_override: null };
const CONTACT_FULL = {
  id: 9,
  user_id: USER,
  name: "Jane",
  locations: null,
  contact_emails: [{ email: "jane@x.com" }],
  contact_phones: [],
  contact_companies: [],
  contact_schools: [],
  contact_tags: [],
};
const ACTIVE_CONTACT = {
  id: 5,
  name: "Jane",
  industry: null,
  follow_up_frequency_days: 7,
  photo_url: null,
  created_at: "2026-01-01T00:00:00.000Z",
  first_outreach_skipped: false,
  reach_out_snoozed_until: null,
  network_status: "active",
  contact_emails: [{ email: "jane@x.com" }],
};

// ── Classification table ───────────────────────────────────────────────

type Kind =
  | "context"      // client wiring / uid plumbing / pure helper — no queries of its own
  | "scoped"       // driven; every query directly user-scoped (or global table)
  | "ownership"    // driven; child operations covered by an in-invocation ownership assertion
  | "global"       // touches only justified cross-user tables
  | "mcp-covered"  // shared function whose scoping is asserted through a driven db.ts entry
  | "web-only";    // browser/RLS surface — MUST NOT be imported by src/mcp

interface Entry {
  kind: Kind;
  /** For driven kinds: run the function against the recorder. */
  drive?: () => Promise<unknown>;
  /** Fixture router for the drive. Return undefined for defaults. */
  route?: (q: RouteCtx) => unknown | undefined;
  ownership?: OwnershipSpec;
  /** For mcp-covered: the driven db.ts entry that exercises it. */
  coveredBy?: string;
  /**
   * For mcp-covered: a table this function queries. The coveredBy drive must
   * actually hit it, which is what makes coverage real rather than aspirational
   * — several of these are reached only because the createContactFull fixture
   * happens to supply phones/company/school/location, and trimming one line
   * from that literal silently un-covered a function before (CAR-151 review).
   */
  touches?: string;
  /** For global: justification. */
  why?: string;
}

const DB_TABLE: Record<string, Entry> = {
  initDb: { kind: "context" },
  db: { kind: "context" },
  uid: { kind: "context" },

  resolveContact: {
    kind: "scoped",
    drive: async () => {
      await db.resolveContact({ contact_id: 5 });
      await db.resolveContact({ name: "Jane" });
    },
    route: (q) => {
      if (q.table === "contacts" && q.resolution === "maybeSingle") return CONTACT_CORE;
      if (q.table === "contacts") return [CONTACT_CORE];
      return undefined;
    },
  },
  assertContactOwned: {
    kind: "scoped",
    drive: () => db.assertContactOwned(5),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  getContactFull: {
    kind: "scoped",
    drive: () => db.getContactFull(9),
    route: (q) => (q.table === "contacts" && q.resolution === "single" ? CONTACT_FULL : undefined),
  },
  fetchSearchRows: {
    kind: "scoped",
    drive: () => db.fetchSearchRows(),
  },
  buildLastTouchMap: {
    kind: "scoped",
    drive: () => db.buildLastTouchMap([1, 2]),
  },
  createContactFull: {
    kind: "ownership",
    drive: () =>
      db.createContactFull({
        name: "Jane",
        emails: ["Jane@X.com"],
        phones: [{ phone: "555" }],
        company: { name: "Acme", title: "PM" },
        school: { name: "BYU" },
        location: { city: "Provo", state: "UT", country: "United States" },
      }),
  },
  appendNote: {
    kind: "ownership",
    drive: () => db.appendNote(5, "note"),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
    ownership: { allowedRpcs: ["append_contact_note"] },
  },
  tagContact: {
    kind: "ownership",
    drive: () => db.tagContact(5, ["VIP"]),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  setNetworkStatus: {
    kind: "scoped",
    drive: () => db.setNetworkStatus(5, "active"),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  activateContactIfDormant: {
    kind: "scoped",
    drive: () => db.activateContactIfDormant(5),
  },
  setStageOverride: {
    kind: "scoped",
    drive: () => db.setStageOverride(5, "warm"),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  logInteraction: {
    kind: "ownership",
    drive: () => db.logInteraction(5, "call", "2026-07-01", "caught up"),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  createActionItem: {
    kind: "ownership",
    drive: () => db.createActionItem({ title: "Send deck", contactIds: [5] }),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  listActionItems: {
    kind: "scoped",
    drive: () => db.listActionItems({ due: "week" }),
  },
  updateActionItem: {
    kind: "scoped",
    drive: () => db.updateActionItem(7, { complete: true }),
    route: (q) => (q.table === "follow_up_action_items" && q.op === "update" ? [{ id: 7 }] : undefined),
  },
  listDueFollowUps: {
    kind: "scoped",
    drive: () => db.listDueFollowUps(),
    route: (q) => (q.table === "contacts" && !q.headRequested ? [ACTIVE_CONTACT] : undefined),
  },
  getNetworkHealth: {
    kind: "scoped",
    drive: () => db.getNetworkHealth(),
    route: (q) => (q.table === "contacts" && !q.headRequested ? [ACTIVE_CONTACT] : undefined),
  },
  searchEmailHistory: {
    kind: "scoped",
    // Drive BOTH branches: the no-contactId query AND the contactId branch,
    // whose email_message_contacts!inner embed carries no user_id of its own —
    // so its .eq("user_id", uid()) is the only tenant scope, and this gate is
    // what would catch a future refactor dropping it (CAR-159 review F4).
    drive: async () => {
      await db.searchEmailHistory("intro (call)");
      await db.searchEmailHistory("intro (call)", 5);
    },
  },
  getCachedThreadMessages: {
    kind: "scoped",
    drive: () => db.getCachedThreadMessages("thread-1"),
  },
  createScheduledEmail: {
    kind: "scoped",
    drive: () =>
      db.createScheduledEmail({
        to: "jane@x.com",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        scheduledSendAt: "2026-08-01T09:00:00.000Z",
      }),
  },
  createAppDraft: {
    kind: "scoped",
    drive: () => db.createAppDraft({ to: "jane@x.com", subject: "Hi", bodyHtml: "<p>Hi</p>" }),
  },
  listScheduled: {
    kind: "scoped",
    drive: () => db.listScheduled(),
  },
  cancelScheduledEmail: {
    kind: "ownership",
    drive: () => db.cancelScheduledEmail(11),
    route: (q) =>
      q.table === "email_follow_ups" && q.op === "select" ? [{ id: 3 }] : undefined,
  },
  cancelFollowUpSequence: {
    kind: "ownership",
    drive: () => db.cancelFollowUpSequence(3),
  },
  findOriginalOutbound: {
    kind: "scoped",
    drive: () => db.findOriginalOutbound({ threadId: "t-1" }),
    route: (q) =>
      q.table === "email_messages"
        ? [{ gmail_message_id: "g1", thread_id: "t-1", subject: null, date: null, to_addresses: [] }]
        : undefined,
  },
  insertFollowUpSequence: {
    kind: "ownership",
    drive: () =>
      db.insertFollowUpSequence({
        originalGmailMessageId: "g1",
        threadId: "t-1",
        recipientEmail: "jane@x.com",
        contactName: "Jane",
        originalSubject: "Hi",
        originalSentAt: "2026-07-01T00:00:00.000Z",
        messageRows: [
          {
            follow_up_id: 0,
            sequence_number: 1,
            send_after_days: 3,
            subject: "Bump",
            body_html: "<p>Bump</p>",
            status: "pending",
            scheduled_send_at: "2026-07-04T09:05:00.000Z",
          },
        ],
      }),
  },
  getDossierBundle: {
    kind: "ownership",
    drive: () => db.getDossierBundle(9, "recent"),
    route: (q) => (q.table === "contacts" && q.resolution === "single" ? CONTACT_FULL : undefined),
  },
  listCalendarEvents: {
    kind: "scoped",
    drive: () => db.listCalendarEvents("2026-07-01T00:00:00.000Z", "2026-07-31T00:00:00.000Z"),
    route: (q) => {
      if (q.table === "calendar_events")
        return [{ id: 70, attendees: [{ email: "jane@x.com" }], title: "Sync", contact_id: null }];
      if (q.table === "contact_emails")
        return [{ email: "jane@x.com", contact_id: 5, contacts: { id: 5, name: "Jane", photo_url: null, user_id: USER } }];
      return undefined;
    },
  },
  cacheCalendarEvent: {
    kind: "ownership",
    drive: () =>
      db.cacheCalendarEvent({
        googleEventId: "ge-1",
        title: "Coffee",
        description: null,
        startAt: "2026-07-20T16:00:00.000Z",
        endAt: "2026-07-20T16:30:00.000Z",
        meetLink: null,
        attendeeEmails: ["jane@x.com"],
        contactId: 5,
      }),
    route: (q) => (q.table === "contacts" && q.resolution === "maybeSingle" ? CONTACT_CORE : undefined),
  },
  resolveCompanyId: {
    kind: "global",
    why: GLOBAL_TABLES.companies,
    drive: () => db.resolveCompanyId({ name: "Acme" }),
    route: (q) => (q.table === "companies" ? [{ id: 8, name: "Acme" }] : undefined),
  },
  getOrCreateTargetCompany: {
    kind: "scoped",
    drive: () => db.getOrCreateTargetCompany(8),
  },
  addTargetCompanyNote: {
    kind: "ownership",
    drive: () => db.addTargetCompanyNote(40, "Referral program open", null),
    route: (q) => (q.table === "target_companies" && q.resolution === "maybeSingle" ? { id: 40 } : undefined),
  },
  getCompanyName: {
    kind: "global",
    why: GLOBAL_TABLES.companies,
    drive: () => db.getCompanyName(8),
    route: (q) => (q.table === "companies" && q.resolution === "maybeSingle" ? { id: 8, name: "Acme" } : undefined),
  },
};

const DATA_TABLES: Record<string, Record<string, Entry>> = {
  "@/lib/data/client": {
    setDataClient: { kind: "context" },
    db: { kind: "context" },
    must: { kind: "context" },
  },
  "@/lib/data/postgrest": {
    escapeIlike: { kind: "context" },
    chunkList: { kind: "context" },
    chunked: { kind: "context" },
    paginateAll: { kind: "context" },
  },
  "@/lib/data/contacts": {
    getContactEmailLookup: { kind: "mcp-covered", coveredBy: "listCalendarEvents", touches: "contact_emails" },
    getContactById: { kind: "mcp-covered", coveredBy: "getContactFull", touches: "contacts" },
    createContact: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "contacts" },
    createContacts: { kind: "web-only" },
    appendContactNote: { kind: "mcp-covered", coveredBy: "appendNote", touches: "rpc:append_contact_note" },
    findOrCreateCompany: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "companies" },
    findOrCreateSchool: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "schools" },
    findOrCreateLocation: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "locations" },
    addEmailToContact: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "contact_emails" },
    addPhoneToContact: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "contact_phones" },
    addCompanyToContact: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "contact_companies" },
    addSchoolToContact: { kind: "mcp-covered", coveredBy: "createContactFull", touches: "contact_schools" },
    getContacts: { kind: "web-only" },
    getContactsStreamed: { kind: "web-only" },
    updateContact: { kind: "web-only" },
    getFreshJobChangeContactIds: { kind: "web-only" },
    deleteContact: { kind: "web-only" },
    uploadContactPhoto: { kind: "web-only" },
    removeContactPhoto: { kind: "web-only" },
    getEmailProvenance: { kind: "web-only" },
    markEmailVerified: { kind: "web-only" },
    activateContacts: { kind: "web-only" },
    getNetworkTierCounts: { kind: "web-only" },
    activateContact: { kind: "web-only" },
    getTags: { kind: "web-only" },
    createTag: { kind: "web-only" },
    resolveManualCompanyLocation: { kind: "web-only" },
    removeCompaniesFromContact: { kind: "web-only" },
    removeSchoolsFromContact: { kind: "web-only" },
    removeEmailsFromContact: { kind: "web-only" },
    removePhonesFromContact: { kind: "web-only" },
    addTagToContact: { kind: "web-only" },
    removeTagFromContact: { kind: "web-only" },
    // CAR-158: reads one contact's tag names for the availability picker's
    // priority detection. Browser/RLS surface; the MCP has no caller for it.
    getContactTagNames: { kind: "web-only" },
  },
  "@/lib/data/interactions": {
    getInteractions: { kind: "web-only" },
    getAllInteractions: { kind: "web-only" },
    createInteraction: { kind: "web-only" },
    updateInteraction: { kind: "web-only" },
    deleteInteraction: { kind: "web-only" },
  },
  "@/lib/data/meetings": {
    getMeetings: { kind: "web-only" },
    getMeetingsForContact: { kind: "web-only" },
    createMeeting: { kind: "web-only" },
    updateMeeting: { kind: "web-only" },
    deleteMeeting: { kind: "web-only" },
    replaceContactsForMeeting: { kind: "web-only" },
    addContactsToMeeting: { kind: "web-only" },
    createTranscriptSegments: { kind: "web-only" },
    getTranscriptSegments: { kind: "web-only" },
    updateSpeakerContact: { kind: "web-only" },
    deleteTranscriptSegments: { kind: "web-only" },
  },
  "@/lib/data/action-items": {
    createActionItem: { kind: "mcp-covered", coveredBy: "createActionItem", touches: "follow_up_action_items" },
    getActionItems: { kind: "mcp-covered", coveredBy: "listActionItems", touches: "follow_up_action_items" },
    getActionItemsForMeeting: { kind: "web-only" },
    getActionItemsForContact: { kind: "web-only" },
    getCompletedActionItems: { kind: "web-only" },
    getCompletedActionItemsForContact: { kind: "web-only" },
    replaceContactsForActionItem: { kind: "web-only" },
    deleteActionItem: { kind: "web-only" },
    getOnboardingActionItemId: { kind: "web-only" },
    updateActionItem: { kind: "web-only" },
    snoozeActionItem: { kind: "web-only" },
  },
  "@/lib/data/follow-ups": {
    buildLastTouchMap: { kind: "mcp-covered", coveredBy: "buildLastTouchMap", touches: "meeting_contacts" },
    getDueFollowUps: { kind: "mcp-covered", coveredBy: "listDueFollowUps", touches: "contacts" },
    getContactsWithLastTouch: { kind: "mcp-covered", coveredBy: "getNetworkHealth", touches: "contacts" },
    getRelationshipsOnTrack: { kind: "mcp-covered", coveredBy: "getNetworkHealth", touches: "contacts" },
    getNeglectedContacts: { kind: "mcp-covered", coveredBy: "getNetworkHealth", touches: "contacts" },
    getNetworkHealthSummary: { kind: "web-only" },
    snoozeContact: { kind: "web-only" },
    skipContactFirstOutreach: { kind: "web-only" },
    setSuggestionCooldown: { kind: "web-only" },
  },
  "@/lib/data/home": {
    getNetworkingStreak: { kind: "mcp-covered", coveredBy: "getNetworkHealth", touches: "meetings" },
    getHomeCoreData: { kind: "web-only" },
    getActionListCounts: { kind: "web-only" },
    getHomeStats: { kind: "web-only" },
    getActivityHeatmap: { kind: "web-only" },
  },
  "@/lib/data/users": {
    getUserProfile: { kind: "web-only" },
    updateUserProfile: { kind: "web-only" },
    getDismissedGettingStarted: { kind: "web-only" },
    setDismissedGettingStarted: { kind: "web-only" },
    getGmailConnection: { kind: "web-only" },
  },
  "@/lib/data/attachments": {
    uploadAttachment: { kind: "web-only" },
    addAttachmentToContact: { kind: "web-only" },
    addAttachmentToMeeting: { kind: "web-only" },
    getAttachmentsForContact: { kind: "web-only" },
    getAttachmentsForMeeting: { kind: "web-only" },
    getAttachmentUrl: { kind: "web-only" },
    deleteAttachment: { kind: "web-only" },
  },
  "@/lib/data/emails": {
    insertScheduledEmail: { kind: "mcp-covered", coveredBy: "createScheduledEmail", touches: "scheduled_emails" },
    insertEmailDraft: { kind: "mcp-covered", coveredBy: "createAppDraft", touches: "email_drafts" },
    insertFollowUpSequenceRows: { kind: "mcp-covered", coveredBy: "insertFollowUpSequence", touches: "email_follow_ups" },
    cancelScheduledEmailCascade: { kind: "mcp-covered", coveredBy: "cancelScheduledEmail", touches: "scheduled_emails" },
    cancelFollowUpSequenceCascade: { kind: "mcp-covered", coveredBy: "cancelFollowUpSequence", touches: "email_follow_ups" },
  },
};

// Named imports MCP files may take from @/lib/company-queries. The three
// query entry points are userId-parameterized and driven below.
const ALLOWED_COMPANY_QUERIES_IMPORTS = new Set([
  "setCompanyQueriesClient",
  "getContactStages",
  "getCompanies",
  "getCompanyDetail",
  "CompanySummary",
  "ContactStage",
  "CompanyDetail",
]);

// ── Harness plumbing ───────────────────────────────────────────────────

function resetRecorder() {
  state.recorded.length = 0;
  state.route = () => undefined;
  state.nextId = 100;
}

function recorded(): RecordedQuery[] {
  return state.recorded as RecordedQuery[];
}

beforeEach(() => {
  resetRecorder();
  db.initDb(USER);
});

async function runDrive(name: string, entry: Entry) {
  resetRecorder();
  db.initDb(USER);
  state.route = (q) => entry.route?.(q as RouteCtx);
  await entry.drive!();
  // Snapshot before asserting. The recorder is a module-global shared by every
  // drive in this file, so a query from a floating promise could otherwise
  // land mid-assertion and be attributed to the wrong function.
  const captured = [...recorded()];
  expect(captured.length, `${name} drive issued no queries — the fixture no longer exercises it`).toBeGreaterThan(0);
  assertAllScoped(captured, USER, entry.ownership);
  return captured;
}

// ── 1. Export enumeration: every export classified, no stale entries ───

describe("export enumeration", () => {
  it("db.ts: every export has a table entry and every entry an export", () => {
    const exported = Object.keys(db).sort();
    const listed = Object.keys(DB_TABLE).sort();
    expect(listed).toEqual(exported);
  });

  for (const [modPath, table] of Object.entries(DATA_TABLES)) {
    it(`${modPath}: every export has a table entry and every entry an export`, async () => {
      const mod = (await import(/* @vite-ignore */ modPath)) as Record<string, unknown>;
      const exported = Object.keys(mod).sort();
      const listed = Object.keys(table).sort();
      expect(listed).toEqual(exported);
    });
  }

  it("mcp-covered entries point at driven db.ts entries", () => {
    for (const table of Object.values(DATA_TABLES)) {
      for (const [name, entry] of Object.entries(table)) {
        if (entry.kind !== "mcp-covered") continue;
        const target = DB_TABLE[entry.coveredBy ?? ""];
        expect(target?.drive, `${name} coveredBy "${entry.coveredBy}" must be a driven db.ts entry`).toBeTypeOf("function");
        expect(entry.touches, `${name} must declare the table it queries, so coverage can be proven`).toBeTruthy();
      }
    }
  });

  // Without this, "covered" means only that a driver exists — not that it
  // reaches the covered function. A real cross-tenant write bug survived the
  // suite after one line was trimmed from the createContactFull fixture
  // (CAR-151 review), because nothing noticed the function stopped running.
  for (const [modPath, table] of Object.entries(DATA_TABLES)) {
    for (const [name, entry] of Object.entries(table)) {
      if (entry.kind !== "mcp-covered") continue;
      it(`${modPath}: ${name} is actually reached by its ${entry.coveredBy} drive`, async () => {
        const target = DB_TABLE[entry.coveredBy!];
        const captured = await runDrive(entry.coveredBy!, target);
        const tables = captured.map((q) => q.table);
        expect(
          tables,
          `${name} declares touches:"${entry.touches}" but the ${entry.coveredBy} drive never queried it — the fixture no longer exercises this function`,
        ).toContain(entry.touches);
      });
    }
  }

  // `context` is the only classification that is never driven, which makes it
  // the one place an unscoped query could hide behind a label. Every other kind
  // has mechanical enforcement (web-only via the import scan, global via a
  // required justification, mcp-covered via the touches assertion above), so
  // this closes the asymmetry (CAR-151 review).
  it("context-classified exports issue no queries of their own", () => {
    const bodyOf = (src: string, name: string): string | null => {
      const decl = new RegExp(`export (?:async )?function ${name}\\b`).exec(src);
      if (!decl) return null;
      const open = src.indexOf("{", decl.index);
      if (open === -1) return null;
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
      }
      return null;
    };

    const modules: Array<[string, Record<string, Entry>, string]> = [
      ["src/mcp/lib/db.ts", DB_TABLE, path.resolve(__dirname, "../lib/db.ts")],
      ...Object.entries(DATA_TABLES).map(([modPath, table]) =>
        [modPath, table, path.resolve(__dirname, "../../lib", `${modPath.replace("@/lib/", "")}.ts`)] as [string, Record<string, Entry>, string],
      ),
    ];

    const violations: string[] = [];
    for (const [label, table, file] of modules) {
      const src = readFileSync(file, "utf8");
      for (const [name, entry] of Object.entries(table)) {
        if (entry.kind !== "context") continue;
        const body = bodyOf(src, name);
        if (body == null) continue; // not a function declaration (const/type) — nothing to smuggle
        if (/\.from\(|\.rpc\(/.test(body)) {
          violations.push(`${label}: ${name} is classified "context" but issues queries — classify and drive it instead`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("global classifications carry justifications", () => {
    for (const [table, why] of Object.entries(GLOBAL_TABLES)) {
      expect(why.length, `GLOBAL_TABLES.${table} needs a justification`).toBeGreaterThan(20);
    }
    for (const [name, entry] of Object.entries(DB_TABLE)) {
      if (entry.kind === "global") {
        expect(entry.why, `${name} is global-classified and needs a justification`).toBeTruthy();
      }
    }
  });
});

// ── 2. MCP import closure: web-only names must stay web-only ───────────

describe("MCP import closure", () => {
  const mcpDir = path.resolve(__dirname, "..");
  const files = fg.sync("**/*.ts", { cwd: mcpDir, ignore: ["__tests__/**"] });

  const importedNames = (src: string, matcher: (source: string, file: string) => boolean, file: string) => {
    const names: string[] = [];
    const re = /import\s+(type\s+)?{([^}]*)}\s+from\s+["']([^"']+)["']/g;
    for (const m of src.matchAll(re)) {
      const [, typeOnly, namesBlob, source] = m;
      if (typeOnly || !matcher(source, file)) continue;
      for (const raw of namesBlob.split(",")) {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith("type ")) continue;
        names.push(trimmed.split(/\s+as\s+/)[0].trim());
      }
    }
    return names;
  };

  const resolvesTo = (source: string, file: string, target: string) => {
    if (source === `@/lib/${target}`) return true;
    if (!source.startsWith(".")) return false;
    const abs = path.resolve(mcpDir, path.dirname(file), source);
    return abs.endsWith(path.join("src", "lib", target));
  };

  it("never imports the frozen queries barrel", () => {
    for (const file of files) {
      const src = readFileSync(path.join(mcpDir, file), "utf8");
      const names = importedNames(src, (s, f) => resolvesTo(s, f, "queries"), file);
      expect(names, `${file} imports @/lib/queries — import the data module directly`).toEqual([]);
    }
  });

  // The named-import scan above reads only `import { x } from "..."`. These
  // three forms reach the same modules while presenting no braced name list,
  // so they would silently bypass the web-only classification (CAR-151 review).
  // None exist today; this keeps it that way rather than relying on that.
  it("never reaches the data layer through namespace, dynamic, or re-export forms", () => {
    const EVASIONS: Array<[RegExp, string]> = [
      [/import\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/g, "namespace import"],
      [/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, "dynamic import"],
      [/export\s+(?:\*|{[^}]*})\s+from\s+["']([^"']+)["']/g, "re-export"],
    ];
    const REACHES = /(?:@\/lib\/(?:queries|data\/|company-queries)|(?:\.\.?\/)+(?:lib\/)?(?:queries|data\/|company-queries))/;

    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(path.join(mcpDir, file), "utf8");
      for (const [re, label] of EVASIONS) {
        for (const m of src.matchAll(re)) {
          if (REACHES.test(m[1])) {
            violations.push(`${file}: ${label} of "${m[1]}" bypasses the web-only classification scan`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("only imports data-layer names classified as MCP-consumable", () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(path.join(mcpDir, file), "utf8");
      for (const [modPath, table] of Object.entries(DATA_TABLES)) {
        const target = modPath.replace("@/lib/", "");
        const names = importedNames(src, (s, f) => resolvesTo(s, f, target), file);
        for (const name of names) {
          const entry = table[name];
          if (!entry) {
            violations.push(`${file}: ${name} from ${modPath} has no classification entry`);
          } else if (entry.kind === "web-only") {
            violations.push(`${file}: ${name} from ${modPath} is classified web-only (RLS-reliant) and must not run under the service client`);
          }
          if (modPath === "@/lib/data/client" && !file.endsWith(path.join("lib", "db.ts"))) {
            violations.push(`${file}: only src/mcp/lib/db.ts may touch the data-client seam (${name})`);
          }
        }
      }
      const cq = importedNames(src, (s, f) => resolvesTo(s, f, "company-queries"), file);
      for (const name of cq) {
        if (!ALLOWED_COMPANY_QUERIES_IMPORTS.has(name)) {
          violations.push(`${file}: ${name} from @/lib/company-queries is not on the MCP-consumable allowlist`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── 3. Scoping drives: every reachable query is user-scoped ────────────

describe("scoping drives (db.ts surface)", () => {
  const driven = Object.entries(DB_TABLE).filter(([, e]) => e.drive);

  it("every non-context db.ts export is driven", () => {
    const undriven = Object.entries(DB_TABLE)
      .filter(([, e]) => e.kind !== "context" && !e.drive)
      .map(([name]) => name);
    expect(undriven).toEqual([]);
  });

  for (const [name, entry] of driven) {
    it(`${name}: every query is user-scoped`, async () => {
      await runDrive(name, entry);
    });
  }
});

describe("scoping drives (company-queries entry points MCP calls)", () => {
  it("getContactStages scopes every query", async () => {
    resetRecorder();
    db.initDb(USER);
    await getContactStages(USER, [{ id: 5, stage_override: null }]);
    expect(recorded().length).toBeGreaterThan(0);
    assertAllScoped(recorded(), USER);
  });

  it("getCompanies scopes every query", async () => {
    resetRecorder();
    db.initDb(USER);
    await getCompanies(USER, {});
    expect(recorded().length).toBeGreaterThan(0);
    assertAllScoped(recorded(), USER);
  });

  it("getCompanyDetail scopes every query", async () => {
    resetRecorder();
    db.initDb(USER);
    state.route = (q) => ((q as RouteCtx).table === "companies" && (q as RouteCtx).resolution === "maybeSingle" ? { id: 8, name: "Acme" } : undefined);
    await getCompanyDetail(USER, 8);
    expect(recorded().length).toBeGreaterThan(0);
    assertAllScoped(recorded(), USER);
  });
});

// ── 4. Guardrail self-tests: the checker actually rejects unscoped ops ──

describe("checker self-tests (a dropped user_id filter turns the suite red)", () => {
  it("rejects an unscoped read on a user-owned table", () => {
    const q: RecordedQuery = {
      table: "contacts", op: "select", resolution: "await",
      filters: [["eq", "id", 5]], orFilters: [], countRequested: false, headRequested: false, orders: [],
    };
    expect(() => assertAllScoped([q], USER)).toThrow(/not user-scoped/);
  });

  it("rejects a child write whose ownership was never established", () => {
    const q: RecordedQuery = {
      table: "contact_emails", op: "insert", resolution: "await",
      filters: [], orFilters: [], payload: { contact_id: 5, email: "a@b.c" },
      countRequested: false, headRequested: false, orders: [],
    };
    expect(() => assertAllScoped([q], USER)).toThrow(/not user-scoped/);
  });

  it("rejects an rpc without an ownership umbrella", () => {
    const q: RecordedQuery = {
      table: "rpc:append_contact_note", op: "rpc", resolution: "await", rpc: "append_contact_note",
      rpcArgs: { p_contact_id: 5 }, filters: [], orFilters: [], countRequested: false, headRequested: false, orders: [],
    };
    expect(() => assertAllScoped([q], USER)).toThrow(/ownership assertion/);
  });

  // The three below pin the holes the CAR-151 deep review found, each of which
  // let a real scoping regression ship green. Do not relax them without
  // re-running the mutation battery in that review.

  it("rejects a query constrained only by non-id columns, even after ownership exists", () => {
    // The vacuous-ownership hole: `usesOnlyOwnedKeys` used to return true when
    // it found no id to object to, so any query filtered purely on status/dates
    // passed once the owned set was non-empty.
    const scoped: RecordedQuery = {
      table: "contacts", op: "select", resolution: "maybeSingle",
      filters: [["eq", "user_id", USER], ["eq", "id", 5]], orFilters: [],
      countRequested: false, headRequested: false, orders: [], returned: { id: 5 },
    };
    const vacuous: RecordedQuery = {
      table: "email_follow_ups", op: "select", resolution: "await",
      filters: [["eq", "status", "active"]], orFilters: [],
      countRequested: false, headRequested: false, orders: [],
    };
    expect(() => assertAllScoped([scoped, vacuous], USER)).toThrow(/not user-scoped/);
  });

  it("does not treat a filtered id as owned unless the query returned or matched it", () => {
    // The circular-ownership hole: filtering `.in("contact_id", ids)` under a
    // scoped query used to mark those ids owned even when nothing came back,
    // blessing an unscoped sibling query keyed on the same caller-supplied ids.
    const scopedButEmpty: RecordedQuery = {
      table: "meeting_contacts", op: "select", resolution: "await",
      filters: [["eq", "meetings.user_id", USER], ["in", "contact_id", [1, 2]]], orFilters: [],
      selectCols: "contact_id, meetings!inner(meeting_date)",
      countRequested: false, headRequested: false, orders: [], returned: [],
    };
    const unscopedSibling: RecordedQuery = {
      table: "interactions", op: "select", resolution: "await",
      filters: [["in", "contact_id", [1, 2]]], orFilters: [],
      countRequested: false, headRequested: false, orders: [],
    };
    expect(() => assertAllScoped([scopedButEmpty, unscopedSibling], USER)).toThrow(/not user-scoped/);
  });

  it("rejects an embedded user_id filter whose embed is not an inner join", () => {
    // Without !inner, PostgREST returns the parent row anyway with the embed
    // nulled, so the filter restricts nothing. Same filters, one character of
    // difference in the select, opposite security properties.
    const base = {
      table: "interactions", op: "select", resolution: "await",
      filters: [["eq", "contacts.user_id", USER]] as Array<[string, string, unknown]>,
      orFilters: [], countRequested: false, headRequested: false, orders: [],
    };
    expect(() => assertAllScoped([{ ...base, selectCols: "contact_id, contacts!inner()" } as RecordedQuery], USER)).not.toThrow();
    expect(() => assertAllScoped([{ ...base, selectCols: "contact_id, contacts(user_id)" } as RecordedQuery], USER)).toThrow(/not user-scoped/);
  });
});

// ── 5. Web-vs-MCP parity: the MCP projections track the shared logic ───

describe("web-vs-MCP parity (contacts due / on-track / streak)", () => {
  const yesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  };

  const overdueContact = { ...ACTIVE_CONTACT };
  const touch = { contact_id: 5, interaction_date: "2026-06-01T12:00:00.000Z" };

  const parityRoute = (q: RouteCtx) => {
    if (q.table === "contacts" && !q.headRequested) return [overdueContact];
    if (q.table === "interactions" && q.op === "select" && !q.headRequested) return [touch];
    if (q.table === "meetings" && !q.headRequested) return [{ meeting_date: yesterday() }];
    return undefined;
  };

  it("list_due_follow_ups is exactly the shared derivation plus the has_email projection", async () => {
    resetRecorder();
    db.initDb(USER);
    state.route = (q) => parityRoute(q as RouteCtx);
    const mcp = await db.listDueFollowUps();

    const expected = deriveDueFollowUps(
      [overdueContact],
      new Map([[5, touch.interaction_date]]),
      new Date().toISOString(),
    );
    expect(mcp).toEqual(
      expected.map((e) => ({
        id: e.id,
        name: e.name,
        industry: e.industry,
        follow_up_frequency_days: e.follow_up_frequency_days,
        last_touch: e.last_touch,
        days_overdue: e.days_overdue,
        never_contacted: e.never_contacted,
        no_cadence: e.no_cadence,
        has_email: e.emails.length > 0,
      })),
    );
    expect(mcp.length).toBeGreaterThan(0); // the fixture really is overdue
  });

  // The dossier bundle is what the model reads before drafting outreach, so
  // every field in it is a field the model can quote. user_id is selected only
  // to scope the embed (CAR-151 review) and must not reach the payload.
  it("get_dossier does not leak user_id into the action items the model reads", async () => {
    resetRecorder();
    db.initDb(USER);
    state.route = (raw) => {
      const q = raw as RouteCtx;
      if (q.table === "contacts" && q.resolution === "single") return CONTACT_FULL;
      if (q.table === "action_item_contacts") {
        return [{ follow_up_action_items: { id: 11, title: "Send deck", is_completed: false, user_id: USER } }];
      }
      return undefined;
    };
    const bundle = await db.getDossierBundle(9, "recent");

    expect(bundle.openActionItems.length).toBeGreaterThan(0); // fixture flowed through
    for (const item of [...bundle.openActionItems, ...bundle.completedActionItems]) {
      expect(item).not.toHaveProperty("user_id");
    }
  });

  it("get_network_health serves the shared on-track, streak and neglected data verbatim", async () => {
    resetRecorder();
    db.initDb(USER);
    state.route = (q) => parityRoute(q as RouteCtx);
    const health = await db.getNetworkHealth();

    resetRecorder();
    db.initDb(USER);
    state.route = (q) => parityRoute(q as RouteCtx);
    const onTrack = await getRelationshipsOnTrack(USER);
    const streak = await getStreakShared(USER);
    const neglected = await getNeglectedContacts(USER);

    expect(health.onTrack).toEqual({
      percentage: onTrack.percentage,
      onTrack: onTrack.onTrack,
      total: onTrack.total,
    });
    expect(health.streakDays).toBe(streak.streak);
    // neglectedContacts was deliberately left unasserted when this suite was
    // first written, which is precisely where an undocumented behavior change
    // hid (CAR-151 review). It is the shared list, renamed and truncated —
    // pin it so any future divergence between the two surfaces is loud.
    expect(health.neglectedContacts).toEqual(
      neglected
        .map((n) => ({
          id: n.id,
          name: n.name,
          days_since_touch: n.days_since_touch,
          cadence_days: n.follow_up_frequency_days,
        }))
        .slice(0, 15),
    );
    expect(health.onTrack.total).toBeGreaterThan(0); // fixture flowed through
  });
});
