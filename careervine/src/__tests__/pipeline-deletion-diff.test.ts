import { describe, it, expect } from "vitest";
import { collectCycleEntityIds, type CycleFormState } from "@/lib/pipeline-state";
import { cyclePayloadFromForm, diffDeletedIds } from "@/lib/pipeline-queries";

/**
 * CAR-238. `save_pipeline_cycle` used to infer deletions from absence, so a save
 * destroyed every row the saving client had not loaded: another browser tab's
 * notes, and (once MCP notes moved onto the same table) an agent-written note,
 * wiped by the user's next keystroke. Deletions are now named explicitly, and
 * these pin the rule that only ids THIS client dropped may be named.
 */

function form(overrides: Partial<CycleFormState> = {}): CycleFormState {
  return {
    selectedStage: "researching",
    researching: { programs: [], notes: [] },
    applied: { applications: [] },
    interviewing: { rounds: [] },
    closed: { declinedNextCycle: false },
    ...overrides,
  } as CycleFormState;
}

const note = (id: string) => ({ id, body: `body ${id}` });

describe("collectCycleEntityIds", () => {
  it("snapshots ids from every collection", () => {
    const f = form({
      researching: {
        programs: [{ id: "p1", name: "", appsOpen: "", jobPotential: "" }],
        notes: [note("n1"), note("n2")],
      },
      applied: {
        applications: [
          { id: "a1", jobTitle: "", location: "", dateApplied: "", resume: null, coverLetter: null },
        ],
      },
      interviewing: { rounds: [{ id: "r1", date: "", interviewer: "", questions: "" }] },
    } as Partial<CycleFormState>);

    expect(collectCycleEntityIds(f)).toEqual({
      programs: ["p1"],
      notes: ["n1", "n2"],
      applications: ["a1"],
      interview_rounds: ["r1"],
    });
  });

  it("returns empty arrays for an empty cycle", () => {
    expect(collectCycleEntityIds(form())).toEqual({
      programs: [],
      notes: [],
      applications: [],
      interview_rounds: [],
    });
  });
});

describe("diffDeletedIds", () => {
  const empty = { programs: [], notes: [], applications: [], interview_rounds: [] };

  it("names an id the client removed", () => {
    const before = { ...empty, notes: ["keep", "drop"] };
    const after = { ...empty, notes: ["keep"] };
    expect(diffDeletedIds(before, after)).toEqual({ notes: ["drop"] });
  });

  it("returns undefined when nothing was removed", () => {
    const ids = { ...empty, notes: ["a", "b"] };
    expect(diffDeletedIds(ids, ids)).toBeUndefined();
  });

  it("returns undefined when a note was only ADDED", () => {
    expect(diffDeletedIds({ ...empty, notes: ["a"] }, { ...empty, notes: ["a", "b"] })).toBeUndefined();
  });

  it("returns undefined with no prior snapshot, so a first save deletes nothing", () => {
    // The dangerous case: without a baseline we must not guess.
    expect(diffDeletedIds(undefined, { ...empty, notes: ["a"] })).toBeUndefined();
  });

  it("NEVER names a row this client never saw", () => {
    // The whole bug: a concurrent writer's note is absent from `after` only
    // because it was never in `before` either. It must not be deleted.
    const before = { ...empty, notes: ["mine"] };
    const after = { ...empty, notes: ["mine"] };
    const deleted = diffDeletedIds(before, after);
    expect(deleted).toBeUndefined();
    expect(JSON.stringify(deleted ?? {})).not.toContain("theirs");
  });

  it("reports deletions across several collections at once", () => {
    const before = {
      programs: ["p1", "p2"],
      notes: ["n1"],
      applications: ["a1"],
      interview_rounds: ["r1"],
    };
    const after = { programs: ["p1"], notes: ["n1"], applications: [], interview_rounds: ["r1"] };
    expect(diffDeletedIds(before, after)).toEqual({ programs: ["p2"], applications: ["a1"] });
  });
});

describe("cyclePayloadFromForm", () => {
  it("omits `deleted` entirely when nothing was removed", () => {
    // Absent `deleted` is what makes the RPC non-destructive for old clients.
    expect(cyclePayloadFromForm(form())).not.toHaveProperty("deleted");
  });

  it("carries explicit deletions through to the payload", () => {
    const payload = cyclePayloadFromForm(form(), { notes: ["gone"] });
    expect(payload.deleted).toEqual({ notes: ["gone"] });
  });

  it("still serializes the notes it keeps", () => {
    const f = form({ researching: { programs: [], notes: [note("n1")] } } as Partial<CycleFormState>);
    expect(cyclePayloadFromForm(f).notes).toEqual([{ id: "n1", body: "body n1" }]);
  });
});
