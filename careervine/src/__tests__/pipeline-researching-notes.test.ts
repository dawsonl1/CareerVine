import { describe, expect, it } from "vitest";
import {
  createResearchingNoteId,
  createResearchingProgramId,
  defaultCycleFormState,
  normalizeCycleFormState,
} from "@/lib/pipeline-state";
import { formatProgramSummaryLine } from "@/lib/researching-program-summary";

describe("pipeline researching notes", () => {
  it("trims note bodies and drops empty notes on normalize", () => {
    const normalized = normalizeCycleFormState({
      ...defaultCycleFormState(),
      researching: {
        programs: [],
        notes: [
          { id: "n1", body: "  Apps open in September  " },
          { id: "n2", body: "   " },
        ],
      },
    });

    expect(normalized.researching.notes).toHaveLength(1);
    expect(normalized.researching.notes[0].body).toBe("Apps open in September");
    expect(normalized.researching.notes[0].id).toBe("n1");
  });

  it("creates stable note ids", () => {
    expect(createResearchingNoteId()).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("pipeline researching programs", () => {
  it("seeds a program from target-row hints via defaultCycleFormState", () => {
    const seeded = defaultCycleFormState({
      program: "IB Analyst",
      appsOpen: "date:2026-09-01",
      jobPotential: "8",
    });

    expect(seeded.researching.programs).toHaveLength(1);
    expect(seeded.researching.programs[0].name).toBe("IB Analyst");
    expect(seeded.researching.programs[0].appsOpen).toBe("date:2026-09-01");
    expect(seeded.researching.programs[0].jobPotential).toBe("8");
  });

  it("formats program summary lines", () => {
    expect(
      formatProgramSummaryLine({
        id: "1",
        name: "S&T Summer",
        appsOpen: "text:Rolling basis",
        jobPotential: "7",
      }),
    ).toBe("S&T Summer · Apps Rolling basis · 7/10");
  });

  it("creates stable program ids", () => {
    expect(createResearchingProgramId()).toMatch(/^program-|^[0-9a-f-]{36}$/i);
  });
});
