import { describe, expect, it } from "vitest";
import {
  applicationHasContent,
  formatApplicationSummaryLine,
} from "@/lib/applied-application-summary";
import type { PipelineJobApplication } from "@/lib/pipeline-preview-storage";

const base: PipelineJobApplication = {
  id: "a1",
  jobTitle: "",
  location: "",
  dateApplied: "",
  resumeFileId: null,
  coverLetterFileId: null,
};

describe("applied-application-summary", () => {
  it("detects content from job title, location, date, or files", () => {
    expect(applicationHasContent(base)).toBe(false);
    expect(applicationHasContent({ ...base, jobTitle: "Analyst" })).toBe(true);
    expect(applicationHasContent({ ...base, resumeFileId: "f1" })).toBe(true);
  });

  it("formats a summary line with job, location, date, and documents", () => {
    expect(
      formatApplicationSummaryLine({
        ...base,
        jobTitle: "IB Analyst",
        location: "New York",
        dateApplied: "2026-01-15",
        resumeFileId: "r1",
        coverLetterFileId: "c1",
      }),
    ).toBe("IB Analyst · New York · Jan 15, 2026 · Resume + Cover letter");
  });

  it("returns null for empty applications", () => {
    expect(formatApplicationSummaryLine(base)).toBeNull();
  });
});
