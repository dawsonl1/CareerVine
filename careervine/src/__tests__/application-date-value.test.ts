import { describe, expect, it } from "vitest";
import {
  formatApplicationDateDisplay,
  isValidApplicationDate,
  parseApplicationDate,
  toApplicationDateIso,
} from "@/lib/application-date-value";

describe("application-date-value", () => {
  it("validates ISO dates", () => {
    expect(isValidApplicationDate("2026-01-15")).toBe(true);
    expect(isValidApplicationDate("2026-02-30")).toBe(false);
    expect(isValidApplicationDate("not-a-date")).toBe(false);
  });

  it("formats display strings", () => {
    expect(formatApplicationDateDisplay("2026-01-15")).toContain("Jan");
    expect(formatApplicationDateDisplay("2026-01-15")).toContain("2026");
    expect(formatApplicationDateDisplay("")).toBe("");
  });

  it("builds ISO strings from calendar parts", () => {
    expect(toApplicationDateIso(2026, 0, 5)).toBe("2026-01-05");
    expect(parseApplicationDate("2026-01-05")?.getDate()).toBe(5);
  });
});
