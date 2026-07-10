import { describe, expect, it } from "vitest";
import { defaultCycleFormState, normalizeCycleFormState } from "@/lib/pipeline-preview-storage";

describe("pipeline interviewing rounds", () => {
  it("defaults to no interview rounds", () => {
    expect(defaultCycleFormState().interviewing.rounds).toEqual([]);
  });

  it("migrates legacy two empty default rounds to none", () => {
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

    expect(normalized.interviewing.rounds).toEqual([]);
  });

  it("keeps rounds with content and assigns ids", () => {
    const normalized = normalizeCycleFormState({
      selectedStage: "interviewing",
      researching: { programs: [], notes: [] },
      applied: { applications: [] },
      interviewing: {
        rounds: [{ date: "2026-03-01", interviewer: "Alex", questions: "" }],
      },
    });

    expect(normalized.interviewing.rounds).toHaveLength(1);
    expect(normalized.interviewing.rounds[0]?.interviewer).toBe("Alex");
    expect(normalized.interviewing.rounds[0]?.id).toBeTruthy();
  });
});
