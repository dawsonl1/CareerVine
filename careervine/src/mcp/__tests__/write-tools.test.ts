import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRecordingClient, type RecordedQuery } from "./helpers/recording-client";
import { mockServiceClientModule } from "@/__tests__/helpers/mock-supabase";
import { mockAnalyticsServerModule } from "@/__tests__/helpers/mock-analytics";
import { runWithUserAsync } from "@/mcp/user-context";
import { registerContactTools } from "@/mcp/tools/contacts";
import { registerOutreachTools } from "@/mcp/tools/outreach";

/**
 * CAR-265 write tools, driven through their real handlers.
 *
 * The scoping gate (db-scoping.test.ts) already proves each write is
 * user-scoped — that is the security property and it is tested there. These
 * cover the behavior the gate says nothing about: which rows get written, in
 * what order, and what the tool refuses.
 */

// ONE hoisted state object, mutated in place — never reassigned. db.ts caches
// its service client module-globally in ensureClient(), so the client built for
// the first test is the one every later test uses; swapping the state object
// out from under it would silently leave every subsequent test reading the
// first test's routes.
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

const USER = "user-writes";
const CONTACT = { id: 5, name: "Jane Doe", network_status: "prospect", stage_override: null };

type Tool = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function collectTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const fake = { registerTool: (name: string, _c: unknown, fn: never) => { tools.set(name, fn); } } as never;
  registerContactTools(fake);
  registerOutreachTools(fake);
  return tools;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const fn = collectTools().get(name);
  if (!fn) throw new Error(`no tool named ${name}`);
  const res = await runWithUserAsync(USER, () => fn(args));
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

/** Writes recorded against a table, in the order they were issued. */
function writesTo(table: string) {
  return (state.recorded as RecordedQuery[]).filter((q) => q.table === table && q.op !== "select");
}

/** The default fixture. Individual tests narrow it by reassigning state.route. */
/**
 * CAR-271: `resolveCompanyId` reads the caller's company tombstones before it
 * resolves anything, so every company tool now issues this read first.
 *
 * It has to be routed separately from the single-row target lookup below, and
 * the reason is worth stating: it is a LIST read behind `paginateAll`, so
 * answering it with that lookup's single object makes the helper spread a
 * non-iterable — which surfaces as "Spread syntax requires ...iterable" from
 * deep inside the tool, not as anything resembling a routing gap.
 *
 * Keyed on the `is_deleted = true` filter, which is what makes this read the
 * tombstone read and nothing else.
 */
const isTombstoneRead = (q: RecordedQuery): boolean =>
  q.table === "target_companies" &&
  q.filters.some(([m, c, v]) => m === "eq" && c === "is_deleted" && v === true);

const defaultRoute = (q: RecordedQuery): unknown => {
    if (q.table === "contacts" && q.resolution === "maybeSingle") return CONTACT;
    if (q.table === "companies") return { id: 9, name: "Acme" };
    if (isTombstoneRead(q)) return [];
    if (q.table === "target_companies" && q.op === "select") {
      return { id: 21, active_cycle: 2, status: "researching" };
    }
    if (q.table === "contact_emails" && q.op === "select") {
      return [{ id: 31, email: "old@acme.com", is_primary: true }];
    }
    if (q.table === "contact_phones" && q.op === "select") return [];
    // Match on the ilike argument so a name that is not a real tag resolves to
    // nothing, instead of every lookup answering with the same row.
    if (q.table === "tags") {
      const wanted = q.filters.find(([m, c]) => m === "ilike" && c === "name")?.[2];
      return String(wanted).toLowerCase() === "vip" ? [{ id: 77, name: "VIP" }] : [];
    }
    return undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.recorded.length = 0;
  state.route = defaultRoute as (q: unknown) => unknown;
});

describe("update_contact", () => {
  it("writes only the fields passed", async () => {
    const res = await call("update_contact", { contact_id: 5, industry: "SaaS" });

    expect(res.fields).toEqual(["industry"]);
    const [write] = writesTo("contacts");
    expect(write.payload).toEqual({ industry: "SaaS" });
    // A caller setting one field must not blank the rest.
    expect(write.payload).not.toHaveProperty("headline");
  });

  it("refuses an empty patch rather than reporting a no-op as success", async () => {
    await expect(call("update_contact", { contact_id: 5 })).rejects.toThrow(/at least one field/);
    expect(writesTo("contacts")).toHaveLength(0);
  });

  it("accepts null to clear a field, which is not the same as omitting it", async () => {
    const res = await call("update_contact", { contact_id: 5, follow_up_frequency_days: null });
    expect(res.fields).toEqual(["follow_up_frequency_days"]);
    expect(writesTo("contacts")[0].payload).toEqual({ follow_up_frequency_days: null });
  });
});

describe("add_contact_email", () => {
  it("demotes the existing primary BEFORE inserting the new one", async () => {
    await call("add_contact_email", { contact_id: 5, email: "new@acme.com", is_primary: true });

    const writes = writesTo("contact_emails");
    // Order is the assertion: insert-then-demote would leave the contact
    // holding two primaries in between, which the send path cannot resolve.
    expect(writes[0].op).toBe("update");
    expect(writes[0].payload).toMatchObject({ is_primary: false });
    expect(writes[1].op).toBe("insert");
    expect(writes[1].payload).toMatchObject({ email: "new@acme.com", is_primary: true });
  });

  it("lowercases and trims the address", async () => {
    await call("add_contact_email", { contact_id: 5, email: "  NEW@Acme.COM " });
    expect(writesTo("contact_emails").at(-1)?.payload).toMatchObject({ email: "new@acme.com" });
  });

  it("rejects an address the contact already has, case-insensitively", async () => {
    await expect(
      call("add_contact_email", { contact_id: 5, email: "OLD@acme.com" }),
    ).rejects.toThrow(/already on this contact/);
    expect(writesTo("contact_emails")).toHaveLength(0);
  });
});

describe("untag_contact", () => {
  it("deletes the link and reports names that were not on the contact", async () => {
    const res = await call("untag_contact", { contact_id: 5, tags: ["VIP", "Nope"] });

    expect(res.removed).toEqual(["VIP"]);
    expect(res.summary).toContain("not on this contact: Nope");
    const deletes = writesTo("contact_tags");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].op).toBe("delete");
    // The TAG itself survives; only the link goes.
    expect(writesTo("tags")).toHaveLength(0);
  });
});

describe("defer_follow_up", () => {
  it("snoozes and stamps the suggestion cooldown together", async () => {
    await call("defer_follow_up", { contact_id: 5, until: "2026-09-01T00:00:00.000Z" });

    const [write] = writesTo("contacts");
    expect(write.payload).toMatchObject({ reach_out_snoozed_until: "2026-09-01T00:00:00.000Z" });
    // Coupled deliberately: snoozing without the cooldown leaves a contact
    // snoozed and still being suggested.
    expect(write.payload).toHaveProperty("suggestion_cooldown_until");
  });

  it("skips first outreach when asked", async () => {
    await call("defer_follow_up", { contact_id: 5, skip_first_outreach: true });
    expect(writesTo("contacts")[0].payload).toMatchObject({ first_outreach_skipped: true });
  });

  it("refuses when given neither a date nor the skip flag", async () => {
    await expect(call("defer_follow_up", { contact_id: 5 })).rejects.toThrow(/Provide `until`/);
  });
});

describe("set_company_stage", () => {
  it("writes the target status AND mirrors the active cycle", async () => {
    const res = await call("set_company_stage", { company_id: 9, stage: "applied" });

    expect(res.summary).toContain("researching → applied");
    expect(writesTo("target_companies").some((w) => (w.payload as { status?: string }).status === "applied")).toBe(true);
    // The whole reason this function exists: the company page reads the cycle
    // and the list reads the target row, so one without the other desyncs them.
    const cycle = writesTo("pipeline_cycles");
    expect(cycle).toHaveLength(1);
    expect(cycle[0].payload).toMatchObject({ selected_stage: "applied", cycle_number: 2 });
  });

  it("moves BACKWARDS, because a stage set by mistake has to be correctable", async () => {
    state.route = ((q: RecordedQuery) => {
      if (q.table === "companies") return { id: 9, name: "Acme" };
      if (isTombstoneRead(q)) return [];
      if (q.table === "target_companies" && q.op === "select") {
        return { id: 21, active_cycle: 1, status: "interviewing" };
      }
      return undefined;
    }) as (q: unknown) => unknown;
    const res = await call("set_company_stage", { company_id: 9, stage: "researching" });
    expect(res.summary).toContain("interviewing → researching");
    expect(writesTo("pipeline_cycles")[0].payload).toMatchObject({ selected_stage: "researching" });
  });

  it("is a no-op when the company is already at that stage", async () => {
    const res = await call("set_company_stage", { company_id: 9, stage: "researching" });
    expect(res.summary).toContain("already at researching");
    expect(writesTo("pipeline_cycles")).toHaveLength(0);
  });
});

describe("update_company_target", () => {
  it("sets next_app_date, the field the outreach queue orders by", async () => {
    const res = await call("update_company_target", { company_id: 9, next_app_date: "2026-10-01" });

    expect(res.fields).toEqual(["next_app_date"]);
    const write = writesTo("target_companies").find((w) => "next_app_date" in (w.payload as object));
    expect(write?.payload).toMatchObject({ next_app_date: "2026-10-01" });
  });

  it("never writes status or is_targeted, which have their own paths", async () => {
    await call("update_company_target", { company_id: 9, priority_score: 90 });
    for (const w of writesTo("target_companies")) {
      const payload = w.payload as Record<string, unknown>;
      // The insert from getOrCreateTargetCompany legitimately carries is_targeted;
      // the research UPDATE must not.
      if (w.op === "update") {
        expect(payload).not.toHaveProperty("status");
        expect(payload).not.toHaveProperty("is_targeted");
      }
    }
  });

  it("refuses an empty patch", async () => {
    await expect(call("update_company_target", { company_id: 9 })).rejects.toThrow(/at least one field/);
  });
});
