import { describe, expect, it } from "vitest";
import { defaultCycleFormState, normalizeCycleFormState } from "@/lib/pipeline-state";

describe("pipeline interviewing rounds", () => {
  it("defaults to no interview rounds", () => {
    expect(defaultCycleFormState().interviewing.rounds).toEqual([]);
  });

  it("keeps user-added empty rounds and assigns ids", () => {
    const normalized = normalizeCycleFormState({
      selectedStage: "interviewing",
      researching: { programs: [], notes: [] },
      applied: { applications: [] },
      interviewing: {
        rounds: [
          { date: "", interviewer: "", questions: "" },
          { date: "", interviewer: "", questions: "" },
        ],
      },
    } as never);

    expect(normalized.interviewing.rounds).toHaveLength(2);
    expect(normalized.interviewing.rounds.every((r) => r.id)).toBe(true);
  });

  it("keeps rounds with content and assigns ids", () => {
    const normalized = normalizeCycleFormState({
      selectedStage: "interviewing",
      researching: { programs: [], notes: [] },
      applied: { applications: [] },
      interviewing: {
        rounds: [{ date: "2026-03-01", interviewer: "Alex", questions: "" }],
      },
    } as never);

    expect(normalized.interviewing.rounds).toHaveLength(1);
    expect(normalized.interviewing.rounds[0]?.interviewer).toBe("Alex");
    expect(normalized.interviewing.rounds[0]?.id).toBeTruthy();
  });
});
