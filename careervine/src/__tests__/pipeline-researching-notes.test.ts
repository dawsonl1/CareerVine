import { describe, expect, it } from "vitest";
import {
  createResearchingNoteId,
  createResearchingProgramId,
  defaultCycleFormState,
  normalizeCycleFormState,
} from "@/lib/pipeline-preview-storage";
import { formatProgramSummaryLine } from "@/lib/researching-program-summary";

describe("pipeline researching notes", () => {
  it("migrates legacy single note string to notes array", () => {
    const legacy = {
      ...defaultCycleFormState(),
      researching: {
        programs: [],
        note: "Apps open in September",
      },
    } as ReturnType<typeof defaultCycleFormState>;

    const normalized = normalizeCycleFormState(legacy);
    expect(normalized.researching.notes).toHaveLength(1);
    expect(normalized.researching.notes[0].body).toBe("Apps open in September");
    expect(normalized.researching.notes[0].id).toBeTruthy();
  });

  it("creates stable note ids", () => {
    expect(createResearchingNoteId()).toMatch(/^note-|^[0-9a-f-]{36}$/i);
  });
});

describe("pipeline researching programs", () => {
  it("migrates legacy flat researching fields to a program", () => {
    const legacy = {
      ...defaultCycleFormState(),
      researching: {
        notes: [],
        program: "IB Analyst",
        appsOpen: "date:2026-09-01",
        jobPotential: "8",
      },
    } as ReturnType<typeof defaultCycleFormState>;

    const normalized = normalizeCycleFormState(legacy);
    expect(normalized.researching.programs).toHaveLength(1);
    expect(normalized.researching.programs[0].name).toBe("IB Analyst");
    expect(normalized.researching.programs[0].appsOpen).toBe("date:2026-09-01");
    expect(normalized.researching.programs[0].jobPotential).toBe("8");
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
