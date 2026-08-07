import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRecordingClient, type RecordedQuery } from "./helpers/recording-client";
import { mockServiceClientModule } from "@/__tests__/helpers/mock-supabase";
import { mockAnalyticsServerModule } from "@/__tests__/helpers/mock-analytics";
import { runWithUserAsync } from "@/mcp/user-context";
import { registerUpkeepTools } from "@/mcp/tools/upkeep";
import * as db from "@/mcp/lib/db";

/**
 * CAR-275 `update_interaction`, driven through its real handler.
 *
 * db-scoping.test.ts already proves the write is user-scoped — that is the
 * security property and it is tested there. This covers what the gate says
 * nothing about: which columns get written, what the type/detail CHECK forces,
 * and what the tool refuses outright.
 */

// ONE hoisted state object, mutated in place — never reassigned. db.ts caches
// its service client module-globally, so the client built for the first test is
// the one every later test uses.
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

const USER = "user-edit";
const INTERACTION = {
  id: 41,
  contact_id: 5,
  interaction_date: "2026-07-01T00:00:00.000Z",
  interaction_type: "coffee",
  interaction_type_detail: null as string | null,
  summary: "caught up",
  is_excluded: false,
  email_message_id: null as number | null,
  contacts: { user_id: USER },
};

type Tool = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function collectTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const fake = { registerTool: (name: string, _c: unknown, fn: never) => { tools.set(name, fn); } } as never;
  registerUpkeepTools(fake);
  return tools;
}

async function call(args: Record<string, unknown>) {
  const fn = collectTools().get("update_interaction");
  if (!fn) throw new Error("no update_interaction tool");
  const res = await runWithUserAsync(USER, () => fn(args));
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

/** Writes recorded against a table, in the order they were issued. */
function writesTo(table: string) {
  return (state.recorded as RecordedQuery[]).filter((q) => q.table === table && q.op !== "select");
}

/** The one interaction write the tool makes, as a plain column patch. */
function interactionPatch(): Record<string, unknown> {
  const writes = writesTo("interactions");
  expect(writes).toHaveLength(1);
  return writes[0].payload as Record<string, unknown>;
}

/** Overrides the stored row for a single test. */
function storedRow(overrides: Partial<typeof INTERACTION> = {}) {
  const row = { ...INTERACTION, ...overrides };
  state.route = ((q: RecordedQuery) => {
    if (q.table === "interactions" && q.resolution === "maybeSingle") return row;
    if (q.table === "interactions" && q.op === "update") return { id: row.id };
    // resolveContact / assertContactOwned answer with the id they were asked
    // for, so the destination of a move is a real, owned contact.
    if (q.table === "contacts" && q.resolution === "maybeSingle") {
      const asked = q.filters.find(([m, c]) => m === "eq" && c === "id")?.[2];
      return { id: asked ?? 5, name: `Contact ${asked ?? 5}`, network_status: "prospect", stage_override: null };
    }
    return undefined;
  }) as (q: unknown) => unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.recorded.length = 0;
  storedRow();
});

describe("field edits", () => {
  it("writes only the fields passed", async () => {
    await call({ interaction_id: 41, summary: "Talked through their PM loop" });

    // A caller fixing the summary must not restate — and therefore silently
    // rewrite — the type, date or contact.
    expect(interactionPatch()).toEqual({ summary: "Talked through their PM loop" });
  });

  it("accepts null to clear a summary, which is not the same as omitting it", async () => {
    await call({ interaction_id: 41, summary: null });
    expect(interactionPatch()).toEqual({ summary: null });
  });

  it("normalizes an ISO date to a full timestamp", async () => {
    await call({ interaction_id: 41, date: "2026-06-15" });
    expect(interactionPatch()).toEqual({ interaction_date: "2026-06-15T00:00:00.000Z" });
  });

  it("refuses an empty patch rather than reporting a no-op as success", async () => {
    await expect(call({ interaction_id: 41 })).rejects.toThrow(/Nothing to update/);
    expect(writesTo("interactions")).toHaveLength(0);
  });

  it("refuses an unparseable date without writing anything", async () => {
    await expect(call({ interaction_id: 41, date: "next tuesday" })).rejects.toThrow(/Invalid date/);
    expect(writesTo("interactions")).toHaveLength(0);
  });

  it("reports each change so a caller can confirm the edit landed", async () => {
    const res = await call({ interaction_id: 41, summary: "x", date: "2026-06-15" });
    expect(res.summary).toContain("dated 2026-06-15T00:00:00.000Z");
    expect(res.summary).toContain("summary updated");
    expect(res.interaction_id).toBe(41);
  });
});

/**
 * `interactions_interaction_type_detail_check` rejects a detail that outlives
 * the type that justified it, so the pair is always recomputed together.
 */
describe("the type/detail pair", () => {
  it("clears a stale detail when the type moves off 'other'", async () => {
    storedRow({ interaction_type: "other", interaction_type_detail: "LinkedIn DM" });

    await call({ interaction_id: 41, type: "coffee" });

    // The caller never mentioned detail. Carrying "LinkedIn DM" onto a coffee
    // chat is exactly the 23514 the CHECK exists to raise.
    expect(interactionPatch()).toEqual({ interaction_type: "coffee", interaction_type_detail: null });
  });

  it("keeps a detail supplied alongside 'other'", async () => {
    await call({ interaction_id: 41, type: "other", detail: "Conference panel" });
    expect(interactionPatch()).toEqual({ interaction_type: "other", interaction_type_detail: "Conference panel" });
  });

  it("drops a detail sent alongside a type that cannot carry one", async () => {
    await call({ interaction_id: 41, type: "text", detail: "Conference panel" });
    expect(interactionPatch()).toEqual({ interaction_type: "text", interaction_type_detail: null });
  });

  it("re-detailing a row that is already 'other' does not need the type restated", async () => {
    storedRow({ interaction_type: "other", interaction_type_detail: "Old wording" });

    await call({ interaction_id: 41, detail: "New wording" });

    expect(interactionPatch()).toEqual({ interaction_type_detail: "New wording" });
  });

  it("collapses a blank detail to null rather than an empty string", async () => {
    await call({ interaction_id: 41, type: "other", detail: "   " });
    expect(interactionPatch()).toEqual({ interaction_type: "other", interaction_type_detail: null });
  });
});

describe("reassignment", () => {
  it("moves the row and graduates the destination", async () => {
    const res = await call({ interaction_id: 41, move_to_contact_id: 7 });

    expect(interactionPatch()).toEqual({ contact_id: 7 });
    // Moving a real touch onto a prospect forms a relationship, exactly as
    // logging one does.
    expect(writesTo("contacts")).toHaveLength(1);
    expect(writesTo("contacts")[0].payload).toMatchObject({ network_status: "active" });
    expect(res.activated).toBe(true);
    expect(res.contact_id).toBe(7);
    expect(res.summary).toContain("moved to Contact 7");
  });

  it("resolves a destination given by name", async () => {
    state.route = ((q: RecordedQuery) => {
      if (q.table === "interactions" && q.resolution === "maybeSingle") return INTERACTION;
      if (q.table === "interactions" && q.op === "update") return { id: 41 };
      if (q.table === "contacts" && q.resolution === "maybeSingle") {
        return { id: 7, name: "Jane Ruiz", network_status: "prospect", stage_override: null };
      }
      if (q.table === "contacts" && q.op === "select") {
        return [{ id: 7, name: "Jane Ruiz", network_status: "prospect", stage_override: null }];
      }
      return undefined;
    }) as (q: unknown) => unknown;

    const res = await call({ interaction_id: 41, move_to_contact_name: "Jane Ruiz" });

    expect(interactionPatch()).toEqual({ contact_id: 7 });
    expect(res.summary).toContain("moved to Jane Ruiz");
  });

  it("does not graduate anyone when the row already sits on that contact", async () => {
    const res = await call({ interaction_id: 41, move_to_contact_id: 5, summary: "reworded" });

    expect(res.activated).toBe(false);
    // No graduation write at all: a move that moves nothing is not a touch.
    expect(writesTo("contacts")).toHaveLength(0);
    expect(res.summary).not.toContain("moved to");
  });
});

/**
 * Every interaction the send path writes carries `email` plus an
 * email_message_id, and at CAR-242 that was all 70 production rows — so this is
 * the row an agent is most likely to reach for, not an edge case.
 */
describe("system-written email rows", () => {
  const sentEmail = () => storedRow({ interaction_type: "email", email_message_id: 900 });

  it.each([
    ["type", { type: "coffee" }],
    ["date", { date: "2026-06-15" }],
    ["detail", { detail: "whatever" }],
    ["contact", { move_to_contact_id: 7 }],
  ])("refuses to rewrite the %s of a sent email", async (_label, patch) => {
    sentEmail();

    await expect(call({ interaction_id: 41, ...patch })).rejects.toThrow(/written by the email send path/);
    expect(writesTo("interactions")).toHaveLength(0);
  });

  it("still allows annotating what the email accomplished", async () => {
    sentEmail();
    await call({ interaction_id: 41, summary: "They replied asking for a call" });
    expect(interactionPatch()).toEqual({ summary: "They replied asking for a call" });
  });

  it("still allows striking one from the calculations", async () => {
    sentEmail();
    await call({ interaction_id: 41, excluded: true });
    expect(interactionPatch()).toEqual({ is_excluded: true });
  });

  // The guard keys on either signal, so a row missing one is still protected.
  it("catches a row typed 'email' with no message link", async () => {
    storedRow({ interaction_type: "email", email_message_id: null });
    await expect(call({ interaction_id: 41, type: "coffee" })).rejects.toThrow(/email send path/);
  });

  it("catches a message-linked row that is not typed 'email'", async () => {
    storedRow({ interaction_type: "coffee", email_message_id: 900 });
    await expect(call({ interaction_id: 41, type: "text" })).rejects.toThrow(/email send path/);
  });
});

describe("remove and restore", () => {
  it("strikes the row without deleting it", async () => {
    const res = await call({ interaction_id: 41, excluded: true });

    expect(interactionPatch()).toEqual({ is_excluded: true });
    expect(res.summary).toContain("still in the record");
  });

  it("puts a struck row back", async () => {
    storedRow({ is_excluded: true });

    const res = await call({ interaction_id: 41, excluded: false });

    expect(interactionPatch()).toEqual({ is_excluded: false });
    expect(res.summary).toContain("restored");
  });
});

/**
 * The other half of CAR-275: an interaction an agent struck has to stay
 * findable, or `excluded: false` is a restore path to a row nothing can name.
 * Asserted on the query rather than through buildDossier because what changed
 * here is the FILTER, and a pure-function test cannot see one.
 */
describe("get_contact_dossier include_removed", () => {
  beforeEach(() => {
    state.route = ((q: RecordedQuery) =>
      q.table === "contacts" && q.resolution === "single" ? { id: 5, contact_emails: [] } : undefined) as (
      q: unknown,
    ) => unknown;
  });

  /** The is_excluded values each interactions read admits, in issue order. */
  async function admittedValues(includeRemoved?: boolean) {
    // Cleared per call, not per test: recorded queries accumulate, so a test
    // calling this twice would otherwise read the first call's rows back as
    // part of the second's.
    state.recorded.length = 0;
    await runWithUserAsync(USER, () => db.getDossierBundle(5, "recent", includeRemoved));
    return (state.recorded as RecordedQuery[])
      .filter((q) => q.table === "interactions")
      .map((q) => q.filters.find(([, c]) => c === "is_excluded")?.[2]);
  }

  it("admits only live rows by default", async () => {
    // Both legs, the page and the total: a count that included struck rows
    // would report a total the shown list can never reach.
    expect(await admittedValues()).toEqual([[false], [false]]);
  });

  it("admits struck rows when asked, on both the page and the count", async () => {
    expect(await admittedValues(true)).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it("filters on is_excluded either way, rather than dropping the guard", async () => {
    // The regression this pins: expressing the flag as "skip the filter"
    // instead of "widen its values" makes the guard vanish from the chain,
    // where neither the conventions check nor a reader can see it.
    const both = [...(await admittedValues()), ...(await admittedValues(true))];
    // Length asserted first: an empty list would satisfy the loop vacuously.
    expect(both).toHaveLength(4);
    for (const values of both) expect(values).toBeDefined();
  });
});

describe("ownership", () => {
  it("refuses an interaction that is not the caller's, before writing", async () => {
    // The ownership read is scoped through contacts!inner(user_id), so another
    // tenant's id matches zero rows rather than silently succeeding.
    state.route = ((q: RecordedQuery) =>
      q.table === "interactions" && q.resolution === "maybeSingle" ? null : undefined) as (q: unknown) => unknown;

    await expect(call({ interaction_id: 999, summary: "x" })).rejects.toThrow(/No interaction with id 999/);
    expect(writesTo("interactions")).toHaveLength(0);
  });

  it("reads ownership before it writes, not after", async () => {
    await call({ interaction_id: 41, summary: "x" });

    const ops = (state.recorded as RecordedQuery[]).filter((q) => q.table === "interactions");
    expect(ops[0].op).toBe("select");
    expect(ops[0].filters).toContainEqual(["eq", "contacts.user_id", USER]);
    expect(ops[1].op).toBe("update");
  });
});
