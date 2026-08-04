/**
 * Shared-lib query-shape registry (CAR-177, F36).
 *
 * The audit demonstrated that a semantic change to a shared data-layer query
 * (e.g. adding `.is("deleted_at", null)` to a contact read) can pass the whole
 * suite: the hand-rolled builder mocks absorb any filter method they already
 * enumerate, and every assertion checks that specific filters are PRESENT,
 * never that nothing unexpected was added. This registry closes the cheap half
 * of that hole: each shared read is driven through the real setDataClient seam
 * against the recording client, and the full shape of every query it issues —
 * operation, table, ordered filters with semantic literals, orders, resolution
 * — is pinned to an explicit signature. Any drift fails with a diff naming the
 * exact query and filter.
 *
 * On an INTENTIONAL query change, regenerate the pins and review the diff:
 *
 *   DUMP_QUERY_SHAPES=1 npx vitest run src/__tests__/data-query-shapes.test.ts
 *
 * prints the updated EXPECTED block to stderr; paste it in. Updating a pin is
 * supposed to appear in the PR diff — that visibility is the whole point.
 *
 * Dynamic literals (the user id, timestamps, numeric ids) are masked so pins
 * are stable across runs; static literals (status strings, booleans, null)
 * stay verbatim because they are semantics (`eq(network_status="active")`).
 * The structural fix (integration-tier tests over real PostgREST) is tracked
 * separately; this registry is deliberately mock-level and cheap.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  createRecordingClient,
  createRecordingState,
  type RecordedQuery,
} from "../mcp/__tests__/helpers/recording-client";
import { setDataClient, type QueryClient } from "@/lib/data/client";
import {
  buildLastTouchMap,
  getContactsWithLastTouch,
  getDueFollowUps,
  getNeglectedContacts,
  getNetworkHealthSummary,
  getRelationshipsOnTrack,
} from "@/lib/data/follow-ups";
import {
  getActionListCounts,
  getActivityHeatmap,
  getHomeCoreData,
  getHomeStats,
  getNetworkingStreak,
} from "@/lib/data/home";
import {
  getActionItems,
  getCompletedActionItems,
  getOnboardingActionItemId,
} from "@/lib/data/action-items";
import { getContactById, getContactEmailLookup, getTags } from "@/lib/data/contacts";

const USER = "user-1";
const state = createRecordingState();

beforeEach(() => {
  state.recorded.length = 0;
  state.route = () => undefined;
  setDataClient(createRecordingClient(state) as unknown as QueryClient);
});

// The seam is a module-global singleton — restore the browser fallback so
// suites sharing this worker never see the recorder.
afterAll(() => setDataClient(null));

// ── Signature encoding ─────────────────────────────────────────────────

const maskIso = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, "$date");

function lit(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return "$n";
  if (Array.isArray(v)) return "[…]";
  if (typeof v === "string") {
    if (v === USER) return "$uid";
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return "$date";
    return JSON.stringify(v);
  }
  return "$v";
}

function signature(q: RecordedQuery): string {
  const op = q.op + (q.headRequested ? "·head" : "") + (q.countRequested ? "·count" : "");
  const parts = [
    ...q.filters.map(([m, col, val]) => `${m}(${col}=${lit(val)})`),
    ...q.orFilters.map((expr) => `or(${maskIso(expr)})`),
    ...q.orders.map((col) => `order(${col})`),
  ];
  const res = q.resolution === "await" ? "" : ` [${q.resolution}]`;
  return `${op} ${q.table}${res} ${parts.join(" ")}`.trim();
}

// ── Drives ─────────────────────────────────────────────────────────────

const DRIVES: Record<string, () => Promise<unknown>> = {
  buildLastTouchMap: () => buildLastTouchMap(USER, [1, 2]),
  getDueFollowUps: () => getDueFollowUps(USER),
  getContactsWithLastTouch: () => getContactsWithLastTouch(USER),
  getRelationshipsOnTrack: () => getRelationshipsOnTrack(USER),
  getNeglectedContacts: () => getNeglectedContacts(USER),
  getNetworkHealthSummary: () => getNetworkHealthSummary(USER),
  getHomeCoreData: () => getHomeCoreData(USER),
  getActionListCounts: () => getActionListCounts(USER),
  getNetworkingStreak: () => getNetworkingStreak(USER),
  getHomeStats: () => getHomeStats(USER),
  getActivityHeatmap: () => getActivityHeatmap(USER),
  getActionItems: () => getActionItems(USER),
  getCompletedActionItems: () => getCompletedActionItems(USER),
  getOnboardingActionItemId: () => getOnboardingActionItemId(USER),
  getContactById: () => getContactById(5, USER),
  getContactEmailLookup: () => getContactEmailLookup(USER),
  getTags: () => getTags(USER),
};

// ── Pinned shapes ──────────────────────────────────────────────────────

const EXPECTED: Record<string, string[]> = {
  buildLastTouchMap: [
    "select meeting_contacts eq(meetings.user_id=$uid) in(contact_id=[…]) order(contact_id) order(meeting_id)",
    "select interactions eq(contacts.user_id=$uid) in(contact_id=[…]) order(id)",
  ],
  getDueFollowUps: [
    'select contacts eq(user_id=$uid) eq(network_status="active") order(name) order(id)',
  ],
  getContactsWithLastTouch: [
    'select contacts eq(user_id=$uid) eq(network_status="active") order(name) order(id)',
  ],
  getRelationshipsOnTrack: [
    'select contacts eq(user_id=$uid) eq(network_status="active") order(id)',
  ],
  getNeglectedContacts: [
    'select contacts eq(user_id=$uid) eq(network_status="active") order(name) order(id)',
  ],
  getNetworkHealthSummary: [
    'select contacts eq(user_id=$uid) eq(network_status="active") order(name) order(id)',
  ],
  // CAR-223: the action-items leg is now paginated like the contacts leg beside
  // it, which adds the order(id) page-boundary tiebreak and moves it first.
  getHomeCoreData: [
    "select follow_up_action_items eq(user_id=$uid) eq(is_completed=false) or(snoozed_until.is.null,snoozed_until.lt.$date) order(due_at) order(id)",
    'select contacts eq(user_id=$uid) eq(network_status="active") order(name) order(id)',
  ],
  getActionListCounts: [
    "select·head·count follow_up_action_items eq(user_id=$uid) eq(is_completed=false) or(direction.is.null,direction.neq.waiting_on)",
    "select·head·count contacts eq(user_id=$uid) not(follow_up_frequency_days=null)",
    'select·head·count contacts eq(user_id=$uid) eq(network_status="active") gte(created_at=$date)',
  ],
  getNetworkingStreak: [
    "select meetings eq(user_id=$uid) gte(meeting_date=$date) order(id)",
    "select follow_up_action_items eq(user_id=$uid) eq(is_completed=true) gte(completed_at=$date) order(id)",
    "select interactions eq(contacts.user_id=$uid) gte(interaction_date=$date) order(id)",
  ],
  getHomeStats: [
    "select·head·count meetings eq(user_id=$uid) gte(meeting_date=$date)",
    "select·head·count meetings eq(user_id=$uid) gte(meeting_date=$date) lt(meeting_date=$date)",
    "select·head·count follow_up_action_items eq(user_id=$uid) eq(is_completed=false)",
    "select·head·count follow_up_action_items eq(user_id=$uid) eq(is_completed=true) gte(completed_at=$date)",
    "select·head·count follow_up_action_items eq(user_id=$uid) eq(is_completed=true) gte(completed_at=$date) lt(completed_at=$date)",
    'select·head·count contacts eq(user_id=$uid) eq(network_status="active") gte(created_at=$date)',
    'select·head·count contacts eq(user_id=$uid) eq(network_status="active") gte(created_at=$date) lt(created_at=$date)',
    "select·head·count interactions eq(contacts.user_id=$uid) gte(interaction_date=$date)",
    "select·head·count interactions eq(contacts.user_id=$uid) gte(interaction_date=$date) lt(interaction_date=$date)",
    'select·head·count email_messages eq(user_id=$uid) eq(direction="outbound") gte(date=$date)',
    'select·head·count email_messages eq(user_id=$uid) eq(direction="outbound") gte(date=$date) lt(date=$date)',
  ],
  getActivityHeatmap: [
    "select meetings eq(user_id=$uid) gte(meeting_date=$date) order(id)",
    "select follow_up_action_items eq(user_id=$uid) eq(is_completed=true) gte(completed_at=$date) order(id)",
    "select interactions eq(contacts.user_id=$uid) gte(interaction_date=$date) order(id)",
    'select email_messages eq(user_id=$uid) eq(direction="outbound") gte(date=$date) order(id)',
    "select contacts eq(user_id=$uid) gte(created_at=$date) order(id)",
  ],
  getActionItems: [
    "select follow_up_action_items eq(user_id=$uid) eq(is_completed=false) or(snoozed_until.is.null,snoozed_until.lt.$date) order(due_at) order(id)",
  ],
  // CAR-223: paginated, so completed_at (nullable on legacy rows) gains an
  // order(id) tiebreak to keep page boundaries stable.
  getCompletedActionItems: [
    "select follow_up_action_items eq(user_id=$uid) eq(is_completed=true) order(completed_at) order(id)",
  ],
  getOnboardingActionItemId: [
    'select follow_up_action_items [maybeSingle] eq(user_id=$uid) eq(source="onboarding") eq(is_completed=false)',
  ],
  getContactById: [
    // The two embedded orders are what make the profile page's sort input
    // deterministic instead of plan-dependent (CAR-216).
    "select contacts [single] eq(id=$n) eq(user_id=$uid) order(contact_companies.id) order(contact_schools.id)",
  ],
  getContactEmailLookup: [
    "select contact_emails eq(contacts.user_id=$uid) order(id)",
  ],
  getTags: [
    "select tags eq(user_id=$uid) order(name)",
  ],
};

// ── Harness ────────────────────────────────────────────────────────────

const actual: Record<string, string[]> = {};
const DUMP = Boolean(process.env.DUMP_QUERY_SHAPES);

afterAll(() => {
  if (!DUMP) return;
  const body = Object.entries(actual)
    .map(([name, sigs]) => `  ${name}: [\n${sigs.map((s) => `    ${JSON.stringify(s)},`).join("\n")}\n  ],`)
    .join("\n");
  process.stderr.write(`\nconst EXPECTED: Record<string, string[]> = {\n${body}\n};\n\n`);
});

describe("shared data-layer query shapes are pinned (CAR-177, F36)", () => {
  it("every drive has a pin and every pin a drive", () => {
    if (DUMP) return;
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(DRIVES).sort());
  });

  for (const [name, drive] of Object.entries(DRIVES)) {
    it(`${name} issues exactly its pinned queries`, async () => {
      await drive();
      const sigs = state.recorded.map(signature);
      actual[name] = sigs;
      expect(sigs.length, `${name} issued no queries — the drive no longer exercises it`).toBeGreaterThan(0);
      if (DUMP) return;
      expect(
        sigs,
        `${name}'s query shape changed. If intentional, regenerate the pins (DUMP_QUERY_SHAPES=1, see file header) and let the PR diff show the change.`,
      ).toEqual(EXPECTED[name]);
    });
  }
});
