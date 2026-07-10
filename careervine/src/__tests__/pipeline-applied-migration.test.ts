import { describe, expect, it } from "vitest";
import { normalizeCycleFormState } from "@/lib/pipeline-preview-storage";

describe("pipeline applied migration", () => {
  it("migrates legacy flat applied fields into application rows", () => {
    const normalized = normalizeCycleFormState({
      selectedStage: "applied",
      researching: { programs: [], notes: [] },
      applied: {
        resume: "https://example.com/resume",
        coverLetter: "",
        dateApplied: "2026-02-01",
        locations: ["New York", "Chicago"],
      } as never,
      interviewing: { rounds: [] },
    });

    expect(normalized.applied.applications).toHaveLength(2);
    expect(normalized.applied.applications[0]).toMatchObject({
      location: "New York",
      dateApplied: "2026-02-01",
      resumeFileId: null,
    });
    expect(normalized.applied.applications[1].location).toBe("Chicago");
  });

  it("keeps structured applications on read", () => {
    const normalized = normalizeCycleFormState({
      selectedStage: "applied",
      researching: { programs: [], notes: [] },
      applied: {
        applications: [
          {
            id: "app-1",
            jobTitle: "S&T",
            location: "Remote",
            dateApplied: "2026-03-01",
            resumeFileId: "file-1",
            coverLetterFileId: null,
          },
        ],
      },
      interviewing: { rounds: [] },
    });

    expect(normalized.applied.applications).toHaveLength(1);
    expect(normalized.applied.applications[0].jobTitle).toBe("S&T");
    expect(normalized.applied.applications[0].resumeFileId).toBe("file-1");
  });
});
