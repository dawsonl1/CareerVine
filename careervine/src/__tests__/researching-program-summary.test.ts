import { describe, expect, it } from "vitest";
import { formatProgramSummaryLine, programHasContent } from "@/lib/researching-program-summary";

describe("researching-program-summary", () => {
  it("detects program content", () => {
    expect(
      programHasContent({ id: "1", name: "", appsOpen: "", jobPotential: "" }),
    ).toBe(false);
    expect(
      programHasContent({ id: "1", name: "IB", appsOpen: "", jobPotential: "" }),
    ).toBe(true);
  });

  it("formats partial program lines", () => {
    expect(
      formatProgramSummaryLine({
        id: "1",
        name: "",
        appsOpen: "month:2026-09",
        jobPotential: "",
      }),
    ).toBe("Apps September 2026");
  });
});
