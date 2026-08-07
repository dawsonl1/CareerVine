import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRecordingClient, type RecordedQuery } from "./helpers/recording-client";
import { mockServiceClientModule } from "@/__tests__/helpers/mock-supabase";
import { mockAnalyticsServerModule } from "@/__tests__/helpers/mock-analytics";
import { runWithUserAsync } from "@/mcp/user-context";
import { registerOutreachTools } from "@/mcp/tools/outreach";

/**
 * CAR-270 pipeline tools.
 *
 * The scoping gate proves these are user-scoped. These cover what it does not:
 * the shape an agent actually receives, and the append semantics — which matter
 * because `save_pipeline_cycle` renumbers `position` across whatever payload it
 * is handed, and because CAR-238 made deletion explicit so a writer that omits
 * rows must not remove them.
 */

// One hoisted state, mutated in place: db.ts caches its service client
// module-globally, so a reassigned state object would leave every later test
// reading the first one's fixtures.
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

const USER = "user-pipeline";

type Tool = (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function tool(name: string): Tool {
  const tools = new Map<string, Tool>();
  registerOutreachTools({
    registerTool: (n: string, _c: unknown, fn: never) => { tools.set(n, fn); },
  } as never);
  const fn = tools.get(name);
  if (!fn) throw new Error(`no tool ${name}`);
  return fn;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await runWithUserAsync(USER, () => tool(name)(args));
  const text = res.content[0].text;
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

const TARGET = { id: 21, location_id: null, is_targeted: true, active_cycle: 1, status: "applied" };
const CYCLE = {
  id: 31,
  target_company_id: 21,
  cycle_number: 1,
  selected_stage: "applied",
  declined_next_cycle: false,
};

/** One application and one note already on the cycle. */
function fullRoute(q: RecordedQuery): unknown {
  if (q.table === "companies") return { id: 9, name: "Acme" };
  if (q.table === "target_companies" && q.op === "select") return [TARGET];
  if (q.table === "pipeline_cycles") return [CYCLE];
  if (q.table === "pipeline_applications") {
    return [{
      id: "app-existing", cycle_id: 31, job_title: "Existing PM", location: "SF",
      date_applied: "2026-01-01", position: 0,
      resume_path: "user/abc.pdf", resume_name: "resume.pdf", resume_size_bytes: 1234,
      cover_letter_path: null, cover_letter_name: null, cover_letter_size_bytes: null,
    }];
  }
  if (q.table === "pipeline_notes") return [{ id: "note-1", cycle_id: 31, body: "Apps open in Sept", position: 0 }];
  if (q.table === "pipeline_interview_rounds") return [];
  if (q.table === "pipeline_programs") return [];
  return undefined;
}

/** The payload handed to save_pipeline_cycle. */
function rpcPayload() {
  const rpc = (state.recorded as RecordedQuery[]).find((q) => q.rpc === "save_pipeline_cycle");
  return rpc?.rpcArgs as { p_target_company_id: number; p_cycle_number: number; p_payload: Record<string, unknown> } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.recorded.length = 0;
  state.route = fullRoute as (q: unknown) => unknown;
});

describe("get_company_pipeline", () => {
  it("returns the board: scope, cycle, stage, notes, applications", async () => {
    const res = await call("get_company_pipeline", { company_id: 9 });

    expect(res.scopes).toHaveLength(1);
    const scope = res.scopes[0];
    expect(scope).toMatchObject({ scope: "all", target_id: 21, active_cycle: 1 });
    const cycle = scope.cycles[0];
    expect(cycle).toMatchObject({ cycle_number: 1, stage: "applied", declined_next_cycle: false });
    expect(cycle.applications[0]).toMatchObject({ job_title: "Existing PM", location: "SF" });
  });

  it("surfaces the intel notes add_company_intel writes", async () => {
    // The asymmetry this ticket exists for: those notes live in pipeline_notes,
    // while get_company returns a different table entirely, so before this the
    // agent could not read back a note it had just written.
    const res = await call("get_company_pipeline", { company_id: 9 });
    expect(res.scopes[0].cycles[0].notes).toEqual(["Apps open in Sept"]);
  });

  it("gives the resume's name and size but never its storage path", async () => {
    // The path is `${userId}/${uuid}.pdf` in a private bucket: unusable without
    // a signed URL, and it embeds the user's uuid.
    const app = (await call("get_company_pipeline", { company_id: 9 })).scopes[0].cycles[0].applications[0];
    expect(app.resume).toEqual({ name: "resume.pdf", size_bytes: 1234 });
    expect(JSON.stringify(app)).not.toContain("user/abc.pdf");
  });

  it("labels a per-office scope by its location, not as company-wide", async () => {
    state.route = ((q: RecordedQuery) => {
      if (q.table === "companies") return { id: 9, name: "Acme" };
      if (q.table === "target_companies" && q.op === "select") {
        return [TARGET, { ...TARGET, id: 22, location_id: 77, active_cycle: 2 }];
      }
      if (q.table === "pipeline_cycles") {
        return [CYCLE, { ...CYCLE, id: 32, target_company_id: 22, cycle_number: 2, selected_stage: "interviewing" }];
      }
      return fullRoute(q);
    }) as (q: unknown) => unknown;

    const res = await call("get_company_pipeline", { company_id: 9 });
    const office = res.scopes.find((s: { scope: string }) => s.scope === "77");
    expect(office).toMatchObject({ scope_label: "Office 77", location_id: 77, target_id: 22 });
    expect(res.scopes.find((s: { scope: string }) => s.scope === "all").scope_label).toBe("Company-wide");
  });

  it("says a company is not a target rather than returning an empty board", async () => {
    state.route = ((q: RecordedQuery) =>
      q.table === "companies" ? { id: 9, name: "Acme" } : undefined) as (q: unknown) => unknown;

    const res = await call("get_company_pipeline", { company_id: 9 });
    expect(res.scopes).toEqual([]);
    expect(res.summary).toContain("not a target company");
  });
});

describe("log_application", () => {
  it("appends without disturbing the application already there", async () => {
    const res = await call("log_application", { company_id: 9, job_title: "APM 2027", location: "NYC" });

    const payload = rpcPayload();
    expect(payload?.p_target_company_id).toBe(21);
    const apps = payload?.p_payload.applications as Array<Record<string, unknown>>;
    // Both, in order: sending only the new row would renumber it to position 0
    // and collide with the existing entry.
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ id: "app-existing", job_title: "Existing PM" });
    expect(apps[1]).toMatchObject({ job_title: "APM 2027", location: "NYC" });
    expect(apps[1].id).toBe(res.application_id);
  });

  it("carries the existing application's attachment through untouched", async () => {
    await call("log_application", { company_id: 9, job_title: "APM 2027" });
    const apps = rpcPayload()?.p_payload.applications as Array<Record<string, unknown>>;
    // The append round-trips rows it did not author, so a resume uploaded in the
    // browser must survive an agent logging a second application.
    expect(apps[0]).toMatchObject({ resume_path: "user/abc.pdf", resume_name: "resume.pdf" });
  });

  it("never sends a `deleted` key", async () => {
    await call("log_application", { company_id: 9, job_title: "APM 2027" });
    // CAR-238 made deletion explicit precisely so a writer that has not seen
    // every row cannot destroy the ones it does not know about.
    expect(rpcPayload()?.p_payload).not.toHaveProperty("deleted");
  });

  it("preserves the other collections it is not touching", async () => {
    await call("log_application", { company_id: 9, job_title: "APM 2027" });
    const payload = rpcPayload()?.p_payload as Record<string, unknown>;
    expect(payload.notes).toEqual([{ id: "note-1", body: "Apps open in Sept" }]);
    expect(payload.selected_stage).toBe("applied");
  });

  it("defaults the optional fields to empty rather than writing null", async () => {
    await call("log_application", { company_id: 9, job_title: "APM 2027" });
    const apps = rpcPayload()?.p_payload.applications as Array<Record<string, unknown>>;
    // The columns are NOT NULL with empty-string defaults in the form model, so
    // an omitted location must land as "" and not null.
    expect(apps[1]).toMatchObject({ location: "", date_applied: "" });
  });

  it("targets an explicit cycle_number when given one", async () => {
    state.route = ((q: RecordedQuery) => {
      if (q.table === "pipeline_cycles") {
        return [CYCLE, { ...CYCLE, id: 32, cycle_number: 2, selected_stage: "researching" }];
      }
      return fullRoute(q);
    }) as (q: unknown) => unknown;

    await call("log_application", { company_id: 9, job_title: "Round two", cycle_number: 2 });
    expect(rpcPayload()?.p_cycle_number).toBe(2);
  });

  it("refuses a scope the company does not have", async () => {
    await expect(
      call("log_application", { company_id: 9, job_title: "X", scope: "999" }),
    ).rejects.toThrow(/No pipeline scope/);
  });
});

describe("log_interview_round", () => {
  it("appends a round with interviewer and free-text notes", async () => {
    const res = await call("log_interview_round", {
      company_id: 9, date: "2026-09-15", interviewer: "Ada", notes: "Asked about tradeoffs",
    });

    const rounds = rpcPayload()?.p_payload.interview_rounds as Array<Record<string, unknown>>;
    expect(rounds).toHaveLength(1);
    // The column is `questions`; the UI labels it "Interview notes" and it is
    // free text, so the tool takes `notes` and maps it.
    expect(rounds[0]).toMatchObject({
      interview_date: "2026-09-15", interviewer: "Ada", questions: "Asked about tradeoffs",
    });
    expect(rounds[0].id).toBe(res.round_id);
  });

  it("leaves the applications alone", async () => {
    await call("log_interview_round", { company_id: 9, interviewer: "Ada" });
    const apps = rpcPayload()?.p_payload.applications as Array<Record<string, unknown>>;
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ id: "app-existing" });
  });
});
